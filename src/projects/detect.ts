// Project detection — Phase F V0.4.
//
// Walks the bridge's mounted source root looking for "project" directories.
// A project = any directory that contains at least one child directory whose
// name matches a canonical type folder (Clips / Final Video / Teaser /
// Trailer, via the prefix-match rule in src/thumb/types.ts).
//
// Once a project root is found, we DON'T recurse further inside it — the
// type folders below get processed by the orchestrator's normal walk.
// Multiple sibling projects under the mount root each get their own row.
//
// V1.9 (folder mapping) generalizes this: operator can manually mark
// arbitrary directories as projects, with rules-based detection as the
// default + manual override per project.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { classifyFolderName } from '../thumb/types';

export interface DetectedProject {
  /** Path relative to the source root. Empty string when the mount root
   *  IS the project (no parent grouping above it). */
  relPath: string;
  /** Last segment of relPath (or '<mount root>' when empty). Used as the
   *  default display name in the SaaS UI. */
  displayName: string;
  /** Names of detected type folders inside this project. E.g.
   *  ["Clips", "Final Video", "Teaser - PH Video", "Trailer - Social Video"]. */
  typeFolders: string[];
}

const DOTFILE_AND_NOISE_SKIP = new Set(['@eaDir', '_cache']);

/**
 * Walk the source root looking for project directories. Returns the list of
 * detected projects (relative paths + their type folder names).
 *
 * Algorithm:
 *   - Start at sourceRoot
 *   - For each directory, list child entries
 *   - If any child is a directory whose name classifies as a canonical type,
 *     this directory IS a project. Record it. Don't recurse further inside.
 *   - Otherwise, recurse into each child directory
 *   - Skip dotfiles, `@eaDir`, and any "Bridge Thumbnails" folder
 */
export async function detectProjects(
  sourceRoot: string
): Promise<DetectedProject[]> {
  const found: DetectedProject[] = [];
  await walk(sourceRoot, '', found);
  return found;
}

async function walk(
  sourceRoot: string,
  relDir: string,
  found: DetectedProject[]
): Promise<void> {
  const fullDir = relDir ? path.join(sourceRoot, relDir) : sourceRoot;

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(fullDir, { withFileTypes: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `project-detect: cannot read ${fullDir}: ${(err as Error).message}`
    );
    return;
  }

  // Filter to directories, skip dotfiles + noise + our own output.
  const dirs = entries.filter(
    (e) =>
      e.isDirectory() &&
      !e.name.startsWith('.') &&
      !DOTFILE_AND_NOISE_SKIP.has(e.name) &&
      e.name !== 'Bridge Thumbnails'
  );

  // Check if any child name classifies as a canonical type.
  const typeMatches = dirs
    .map((d) => ({ name: d.name, typeKey: classifyFolderName(d.name) }))
    .filter((x) => x.typeKey !== null);

  if (typeMatches.length > 0) {
    // THIS directory is a project. Record + stop recursing.
    const displayName = relDir
      ? path.posix.basename(relDir)
      : '<mount root>';
    found.push({
      relPath: relDir,
      displayName,
      typeFolders: typeMatches.map((m) => m.name).sort(),
    });
    return;
  }

  // No type folders here — recurse into each child directory.
  for (const dir of dirs) {
    const childRel = relDir ? path.posix.join(relDir, dir.name) : dir.name;
    await walk(sourceRoot, childRel, found);
  }
}
