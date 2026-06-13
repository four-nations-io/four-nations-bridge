// Type classification — Phase F V0.3.
//
// V0.3 detects content type from folder structure: the FIRST path segment
// whose lowercase form starts with a known canonical type name (followed by
// end-of-string OR a separator: space, hyphen, underscore, period) defines
// the type. This lets descriptive folder names like `Teaser - PH Video` or
// `Trailer - Social Video` map to the canonical `Teaser` / `Trailer` types
// without exact-name match.
//
// V0.4 SaaS-side UI adds operator-overridable mapping for files that don't
// fit the canonical folder convention. V1.9 generalizes to a full per-tenant
// folder-mapping system with many-to-one support. V0.3 is hardcoded.

export interface ContentType {
  /** Source folder name as the operator names it (case preserved for messages). */
  sourceFolderName: string;
  /** Output subfolder label inside `Pics/Bridge Thumbnails/`. Always TitleCase. */
  outputLabel: string;
  /** Thumbnail positions to extract. Clips → [0] (first frame for Twitter
   *  cover parity). Full Video / Teaser → 5 evenly-spaced positions avoiding
   *  exact 0/100 (often fade-in/fade-out frames). Trailer → first frame plus
   *  4 more evenly spaced. */
  positions: number[];
}

/** Hardcoded V0.3 type map. Key is the LOWERCASE canonical type name (used
 *  for prefix matching against actual folder names). Value defines output +
 *  positions. */
export const CONTENT_TYPES: Record<string, ContentType> = {
  clips: {
    sourceFolderName: 'Clips',
    outputLabel: 'Clip',
    positions: [0],
  },
  'final video': {
    sourceFolderName: 'Final Video',
    outputLabel: 'Full Video',
    positions: [5, 25, 50, 75, 95],
  },
  teaser: {
    sourceFolderName: 'Teaser',
    outputLabel: 'Teaser',
    positions: [5, 25, 50, 75, 95],
  },
  trailer: {
    sourceFolderName: 'Trailer',
    outputLabel: 'Trailer',
    positions: [0, 25, 50, 75, 95],
  },
};

/** Characters that signal "type name ends here" — separators between the
 *  canonical type name and any descriptive suffix in the folder name. */
const TYPE_SUFFIX_SEPARATORS = new Set([' ', '-', '_', '.']);

/**
 * Try to match a folder name against a canonical type key. Returns the
 * matched type key (lowercase) or null. Matches when:
 *   - folder name (lowercased) === type key, OR
 *   - folder name (lowercased) starts with type key AND the character right
 *     after the type key is one of the suffix separators.
 *
 * Examples for type key "teaser":
 *   "Teaser"            → match
 *   "Teaser - PH Video" → match (separator: ' ')
 *   "Teaser-Social"     → match (separator: '-')
 *   "Teasers"           → no match (no separator after "teaser")
 *   "Teaser2"           → no match
 */
function matchTypeKey(folderName: string, typeKey: string): boolean {
  const lc = folderName.toLowerCase();
  if (lc === typeKey) return true;
  if (lc.length <= typeKey.length) return false;
  if (!lc.startsWith(typeKey)) return false;
  const next = lc.charAt(typeKey.length);
  return TYPE_SUFFIX_SEPARATORS.has(next);
}

/** Find which canonical type (if any) a folder name matches. First-match-wins
 *  over the CONTENT_TYPES iteration order. */
export function classifyFolderName(folderName: string): string | null {
  for (const typeKey of Object.keys(CONTENT_TYPES)) {
    if (matchTypeKey(folderName, typeKey)) return typeKey;
  }
  return null;
}

export interface DetectedType {
  /** Canonical type label for the output subfolder (e.g. 'Clip', 'Full Video'). */
  outputLabel: string;
  /** Position list to extract for this type. */
  positions: number[];
  /** Original folder name as it appears in the source tree (e.g.
   *  'Teaser - PH Video'). Preserved in the output path so that two
   *  descriptive folders sharing a canonical type don't collide on same-named
   *  files. Used as a sub-level inside the output type folder. */
  matchedFolderName: string;
  /** Path segments BEFORE the matched folder segment, joined with '/'. Empty
   *  string when the matched folder is at index 0 (i.e. mount root IS the
   *  project). */
  projectPath: string;
  /** Path segments AFTER the matched folder, joined with '/'. May be empty
   *  for files directly inside the type folder. Includes the filename. */
  rest: string;
}

/**
 * Walk the path segments looking for the FIRST one that matches a known
 * canonical type (via `classifyFolderName`'s prefix rule). Returns the
 * detected type + project path + matched folder name + rest, or null if no
 * segment matches.
 *
 * First-match-wins: if a file is at `Clips/sub/Trailer/foo.mp4`, the `Clips`
 * match at index 0 wins; `Trailer` at index 2 is treated as a normal
 * sub-folder name within the Clips type tree.
 */
/**
 * V0.7.b: limit thumbnail GENERATION to full videos + teasers (operator
 * decision 2026-06-07). Trailers + clips no longer get generated thumbs — this
 * keeps the in-place `Pics/Bridge Thumbnails` footprint small now that those
 * images are indexed + browseable by the picker. Classification (CONTENT_TYPES,
 * project breakdown, etc.) is UNCHANGED — this gate only governs generation.
 */
const THUMB_GEN_OUTPUT_LABELS = new Set(['Full Video', 'Teaser']);
export function shouldGenerateThumbs(detected: DetectedType): boolean {
  return THUMB_GEN_OUTPUT_LABELS.has(detected.outputLabel);
}

export function detectContentType(sourceRelPath: string): DetectedType | null {
  const parts = sourceRelPath.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const typeKey = classifyFolderName(parts[i]);
    if (!typeKey) continue;
    const def = CONTENT_TYPES[typeKey];
    return {
      outputLabel: def.outputLabel,
      positions: def.positions,
      matchedFolderName: parts[i],
      projectPath: parts.slice(0, i).join('/'),
      rest: parts.slice(i + 1).join('/'),
    };
  }
  return null;
}
