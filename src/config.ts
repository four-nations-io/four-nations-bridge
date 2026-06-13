import { z } from 'zod';

import { hostPathToContainerPath } from './source-roots/resolve';

// Phase F content-bridge env contract. Validated at boot via `loadConfig()`;
// throws on missing-or-malformed required vars so misconfiguration fails fast
// rather than producing a half-running bridge.
//
// V0 uses V0-only env vars (CONTENT_BRIDGE_BEARER, the encryption stub key,
// and the hardcoded DEVICE_LABEL enum). V0.8.b absorbs the first slice of the
// original V1.1 plan: bearer + device label may now ALSO come from the setup
// wizard's paired-state file (src/pairing/state.ts) instead of env, so both
// are optional here and the label is free-form (the V0 enum values still match
// the regex). Unpaired mode = no bearer from either source → only the setup UI
// runs (wizard route cluster active) until pairing completes.

const VALID_DEVICE_PLATFORMS = ['linux', 'darwin', 'win32'] as const;

/** Free-form bridge name shape, kept in lockstep with the gateway's
 *  DEVICE_LABEL_REGEX (bridge-gateway/server.js): 1–64 chars, starts with an
 *  alphanumeric, then alphanumerics / space / `_` / `.` / `-`. */
export const DEVICE_LABEL_REGEX = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

// V0.3 thumb-position list. 5%/25%/50%/75%/95% — 0% and 100% can fall on
// fade-ins / black frames; 5/95 give margin without losing open/close framing.
// Override via CONTENT_BRIDGE_THUMB_POSITIONS=5,25,50,75,95 in env.
const DEFAULT_THUMB_POSITIONS = [5, 25, 50, 75, 95];

// Canonical web-app base URL the "browse your content" link defaults to when no
// CONTENT_BRIDGE_APP_URL override is set, so a released bridge needs zero config
// for the link to work. The SaaS's /content/bridge route auto-detects the
// signed-in tenant and redirects to their subdomain (or to /login, which then
// redirects) — so one canonical domain works for every tenant.
//
// Empty here = the link is hidden until either a release bakes in the canonical
// domain or an install sets CONTENT_BRIDGE_APP_URL (handy for dev / self-hosted).
// TODO(release): set this to the canonical SaaS app URL (https://…) once chosen.
const DEFAULT_APP_URL = '';

const ConfigSchema = z.object({
  // Permanent vars
  saasUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith('ws://') || u.startsWith('wss://'), {
      message: 'CONTENT_BRIDGE_SAAS_URL must use ws:// or wss:// scheme',
    }),
  setupUiPort: z.number().int().positive().max(65535),
  appVersion: z.string(),
  devicePlatform: z.enum(VALID_DEVICE_PLATFORMS),

  // Credential + identity — optional in env since V0.8.b (the setup wizard's
  // paired-state file is the other source; main.ts resolves the effective
  // values). When set in env, each must still be well-formed.
  bearer: z
    .string()
    .refine((s) => s === '' || s.length >= 32, {
      message: 'CONTENT_BRIDGE_BEARER must be at least 32 chars when set',
    }),
  deviceLabel: z
    .string()
    .refine((s) => s === '' || DEVICE_LABEL_REGEX.test(s), {
      message:
        'CONTENT_BRIDGE_DEVICE_LABEL must be 1-64 chars: alphanumeric start, then alphanumerics/space/_/./-',
    }),
  sourceRoot: z.string().min(1),
  // V0.9d: optional at boot. Empty is allowed so a creator can enter the key in
  // the setup wizard instead of the .env (web-UI-first onboarding). When empty,
  // main.ts falls back to the wizard-persisted key from paired.json; if neither
  // source has it the bridge boots into the wizard and collects it. Still must be
  // well-formed (64 hex) when set in env.
  encryptionKeyHex: z.string().refine((s) => s === '' || /^[0-9a-fA-F]{64}$/.test(s), {
    message:
      'CONTENT_BRIDGE_ENCRYPTION_KEY must be empty (then entered in the setup wizard) or exactly 64 hex chars (32 bytes)',
  }),

  // V0.3 thumb config
  thumbWritableRoot: z.string().min(1),
  /** Phase F cutover (planning doc 65): the absolute HOST path to the operator's
   *  content folder. Now load-bearing + REQUIRED — it derives the index root (the
   *  mirror `/sources/host<host_path>`, see `sourceRoot` below) AND is auto-
   *  registered as this device's source root on HELLO (so Browse works with zero
   *  CLI). Still the readable path in "thumb: starting [<host-path>] ..." logs. */
  hostContentPath: z
    .string()
    .min(1, 'CONTENT_BRIDGE_HOST_CONTENT_PATH is required (absolute host path to your content folder)')
    .refine(
      (s) => hostPathToContainerPath(s) !== null,
      'CONTENT_BRIDGE_HOST_CONTENT_PATH must be an absolute path with no ".." segments'
    ),
  /**
   * Sub-path within each project where the bridge writes thumbs. ALWAYS
   * constrained to inside the project folder per operator preference. Default
   * `Pics/Bridge Thumbnails`. V0.4 SaaS surface adds a dropdown to change this
   * without editing env (presets like `Pics/Bridge Thumbnails`,
   * `Thumbnails/Bridge`, etc.); for V0.3 it's env-only.
   *
   * Reject any value containing `..` (would escape project folder).
   */
  thumbSubpathWithinProject: z
    .string()
    .min(1)
    .refine(
      (s) => !s.split('/').some((seg) => seg === '..'),
      'CONTENT_BRIDGE_THUMB_SUBPATH_WITHIN_PROJECT cannot contain ".." segments'
    )
    .refine(
      (s) => !s.startsWith('/'),
      'CONTENT_BRIDGE_THUMB_SUBPATH_WITHIN_PROJECT must be relative to the project root, not absolute'
    ),
  thumbPositions: z.array(z.number().int().min(0).max(100)).min(1),
  thumbConcurrency: z.number().int().min(1).max(16),
  thumbDelayMs: z.number().int().min(0).max(60_000),
  thumbCpuNice: z.number().int().min(-20).max(19),
  // Thumb longest-edge max, in px. Default 1080 (operator 2026-06-05: thumbs
  // double as promo stills, worth the extra gen time). Live-overridable from the
  // SaaS up to 3840 (4K-width); `withoutEnlargement` means sources smaller than
  // this never upscale.
  thumbMaxDimPx: z.number().int().min(64).max(3840),
  thumbJpegQuality: z.number().int().min(1).max(100),

  // ─── V0.6 narrow-bind + cache-dir + managed-folder config ────────────────
  // Container path of the RW cache mount where V1 thumbs + 720p proxies land
  // (`/data/cache/<deviceId>/<fileId>/...`). Mount added in V0.6.a compose;
  // the cache-dir WRITE behavior + proxies land in V0.6.b.
  cacheRoot: z.string().min(1),
  // Where the orchestrator writes thumbs. `in_place` = the V0 layout (inside
  // each project's Pics/Bridge Thumbnails) — operator backward-compat default.
  // `cache_dir` = the V1 layout under cacheRoot — becomes default V1.0. V0.6.b
  // implements the cache_dir branch; V0.6.a only carries the flag.
  thumbOutputMode: z.enum(['in_place', 'cache_dir']),
  // Container path of the auto-provisioned managed drop-folder (RW, add-only).
  // Mount + config land in V0.6.a; auto-registration as a source_root + UI
  // surfacing are deferred to V0.7 onboarding (the operator creates in their
  // own real RW content root and never uses this).
  managedRoot: z.string().min(1),
  managedEnabled: z.boolean(),
  // Host-side path the managed folder is bound from — display/onboarding only.
  managedHostPath: z.string(),
  // Default project-template folder (HOST path) copied by create-project when
  // the operator doesn't override it per-create. Empty = no default (a create
  // with "use template" then fails until one is set; "regular folder" still
  // works). Operator can also set this live via the SaaS settings POST
  // (`default_template_path`), which overlays this env default.
  defaultTemplatePath: z.string(),

  // ─── V0.6.b cache + 720p preview-proxy config ────────────────────────────
  // All five are env defaults the operator can override live via the SaaS
  // settings POST (same overlay mechanism as the throttle knobs). Bounds here
  // mirror the next-app settings validator's ALLOWED_KEYS bounds. See
  // arch-note 14 §4 (Tiered cache management) for the rationale behind each.
  //
  // CRF for the H.264 720p proxy. Higher = smaller file + lower quality.
  proxyQualityCrf: z.number().int().min(18).max(35),
  // Max CPU threads the proxy transcode may use. Default 2 — previews are
  // non-essential, so we stay deliberately polite and leave headroom for real
  // workloads (e.g. Hyper Backup); combined with the renice (thumbCpuNice) the
  // proxy yields rather than hogs. 0 = ffmpeg auto (all cores) for those who
  // want speed; raise on beefy machines. (The thumb frame-grab stays single-
  // threaded regardless — it's a one-frame extract.)
  proxyThreads: z.number().int().min(0).max(64),
  // Skip proxy gen (stream the source directly) for sources under this size —
  // clips are small enough to stream as-is; full videos / trailers get proxied.
  proxySkipBelowBytes: z
    .number()
    .int()
    .min(0)
    .max(10 * 1024 ** 3),
  // Idle TTL for proxies (default 25 min). MUST exceed the gateway's pin window
  // (STREAM_PIN_TTL, 15 min): a built proxy is only ever served by a LATER
  // session, and a later session requires a gap > the pin window — so if the TTL
  // were ≤ the pin window the proxy would always be evicted before it could be
  // reused (built-then-evicted-unused). The useful reuse window is (pin, ttl) —
  // ~10 min here. Proxies are per-device + capped (cache_cap_bytes), never on the
  // SaaS, so a longer TTL only trades the creator's own (capped) disk for fewer
  // re-transcodes — it is NOT a SaaS-scaling cost.
  proxyCacheTtlMinutes: z.number().int().min(1).max(1440),
  // Day-grain TTL for thumbs (browsed library-wide for weeks).
  thumbCacheTtlDays: z.number().int().min(1).max(3650),
  // Hard ceiling on total cache size; applies as defense-in-depth after TTL
  // eviction (LRU proxies first, then LRU thumbs).
  cacheCapBytes: z
    .number()
    .int()
    .min(100 * 1024 ** 2)
    .max(100 * 1024 ** 3),

  // ─── V0.8.b setup wizard / pairing ───────────────────────────────────────
  // Directory holding the wizard's paired-state file (paired.json). Lives UNDER
  // the bridge-owned `managed` folder (`/data/managed/_state`) — the one mount
  // that's chowned to the run UID and writable, same as `_cache`. NEVER a Docker
  // named volume (root-owned → the non-root container can't write it) and NEVER
  // a content root.
  stateDir: z.string().min(1),
  // Optional pairing-code prefill: the install script writes the code the
  // creator received into .env so the wizard's code field arrives pre-filled
  // (the creator just confirms). Empty = creator pastes manually.
  pairingCodePrefill: z.string(),
  // Dev/test knob: when true, env CONTENT_BRIDGE_BEARER is IGNORED for the
  // paired/unpaired decision so the wizard can be exercised on a host whose
  // .env already carries the legacy bearer (the operator-NAS dev stack). The
  // paired-state file still wins when present. Never set in production.
  forceWizard: z.boolean(),

  // ─── V0.8.b "Both": headless auto-pair + token-gated LAN setup UI ─────────
  // Auto-pair on boot: when true AND a pairing code is present AND the bridge
  // is otherwise unpaired, the daemon verifies the code against the gateway and
  // persists the pairing ITSELF — no browser, no wizard. For headless NAS
  // installs the creator can't reach localhost:<port>. The bridge's identity
  // name comes from `deviceLabel` (the install script defaults it to the host's
  // hostname). A fresh UUID device key is minted + saved to paired.json, so a
  // later rebuild at the same managed path re-attaches to the same device.
  autoPair: z.boolean(),
  // Expose the setup wizard/status UI beyond loopback (LAN). When true, the host
  // port must be bound to 0.0.0.0 (the installer sets both together) and EVERY
  // non-loopback request to the setup UI must carry the setup token. When false
  // (default) the UI is localhost-only and the Host-header allowlist already
  // rejects LAN browsers (their Host header is the NAS IP, not a localhost
  // form) — so no token is needed in that mode.
  setupUiLan: z.boolean(),
  // Shared secret required for LAN setup-UI access (sent as the
  // X-Content-Bridge-Setup-Token header or a ?token= query param). Empty WHILE
  // setupUiLan=true = fail-closed: every non-loopback request gets a 503 until a
  // token is configured. Ignored entirely when setupUiLan=false.
  setupToken: z.string(),
  // Optional exact extra Host header to allow in LAN mode (e.g. "nas.local" or
  // "nas.local:8124") for creators who reach the NAS by name rather than by IP.
  // Private-IP-literal Host headers are always allowed in LAN mode without this;
  // public hostnames are always rejected (anti-DNS-rebinding).
  setupUiHost: z.string(),
  // Base URL of the account's WEB APP (e.g. https://app.example.com) — distinct
  // from the gateway WSS URL above. Used only to build the "browse your content"
  // link shown on the wizard success screen. Empty = the link is hidden.
  appUrl: z.string().refine((s) => s === '' || /^https?:\/\/.+/.test(s), {
    message: 'CONTENT_BRIDGE_APP_URL must be an http(s) URL when set',
  }),
});

export type BridgeConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): BridgeConfig {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require('../package.json') as { version?: string };

  const positionsRaw = (process.env.CONTENT_BRIDGE_THUMB_POSITIONS ?? '').trim();
  const positions = positionsRaw
    ? positionsRaw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
    : DEFAULT_THUMB_POSITIONS;

  const parsed = ConfigSchema.safeParse({
    saasUrl: process.env.CONTENT_BRIDGE_SAAS_URL ?? '',
    setupUiPort: Number(process.env.CONTENT_BRIDGE_SETUP_UI_PORT ?? '8123'),
    appVersion: `four-nations-bridge@${pkg.version ?? 'unknown'}`,
    devicePlatform: process.env.CONTENT_BRIDGE_DEVICE_PLATFORM ?? '',
    bearer: process.env.CONTENT_BRIDGE_BEARER ?? '',
    deviceLabel: process.env.CONTENT_BRIDGE_DEVICE_LABEL ?? '',
    // Phase F cutover (planning doc 65): the bridge indexes + serves from the
    // source-roots model, not a hardcoded /sources/local. The index root is the
    // MIRROR of the operator's content path (`/sources/host<host_path>`) — the
    // SAME host directory as the old /sources/local, so rel_paths are byte-
    // identical (no re-index). CONTENT_BRIDGE_SOURCE_ROOT is no longer read.
    sourceRoot: hostPathToContainerPath(process.env.CONTENT_BRIDGE_HOST_CONTENT_PATH ?? '') ?? '',
    encryptionKeyHex: process.env.CONTENT_BRIDGE_ENCRYPTION_KEY ?? '',
    thumbWritableRoot: process.env.CONTENT_BRIDGE_THUMB_WRITABLE_ROOT ?? '/writable/source',
    hostContentPath: process.env.CONTENT_BRIDGE_HOST_CONTENT_PATH ?? '',
    thumbSubpathWithinProject: process.env.CONTENT_BRIDGE_THUMB_SUBPATH_WITHIN_PROJECT ?? 'Pics/Bridge Thumbnails',
    thumbPositions: positions,
    thumbConcurrency: Number(process.env.CONTENT_BRIDGE_THUMB_CONCURRENCY ?? '1'),
    thumbDelayMs: Number(process.env.CONTENT_BRIDGE_THUMB_DELAY_MS ?? '200'),
    thumbCpuNice: Number(process.env.CONTENT_BRIDGE_THUMB_CPU_NICE ?? '15'),
    thumbMaxDimPx: Number(process.env.CONTENT_BRIDGE_THUMB_MAX_DIM_PX ?? '1080'),
    thumbJpegQuality: Number(process.env.CONTENT_BRIDGE_THUMB_JPEG_QUALITY ?? '80'),
    cacheRoot: process.env.CONTENT_BRIDGE_CACHE_ROOT ?? '/data/cache',
    thumbOutputMode: process.env.CONTENT_BRIDGE_THUMB_OUTPUT_MODE ?? 'cache_dir',
    managedRoot: process.env.CONTENT_BRIDGE_MANAGED_ROOT ?? '/data/managed',
    managedEnabled:
      (process.env.CONTENT_BRIDGE_MANAGED_ENABLED ?? 'true').toLowerCase() !== 'false',
    managedHostPath: process.env.CONTENT_BRIDGE_MANAGED_HOST_PATH ?? '',
    defaultTemplatePath: process.env.CONTENT_BRIDGE_DEFAULT_TEMPLATE_PATH ?? '',
    proxyQualityCrf: Number(process.env.CONTENT_BRIDGE_PROXY_QUALITY_CRF ?? '28'),
    proxyThreads: Number(process.env.CONTENT_BRIDGE_PROXY_THREADS ?? '2'),
    proxySkipBelowBytes: Number(
      process.env.CONTENT_BRIDGE_PROXY_SKIP_BELOW_BYTES ?? String(100_000_000)
    ),
    proxyCacheTtlMinutes: Number(
      process.env.CONTENT_BRIDGE_PROXY_CACHE_TTL_MINUTES ?? '25'
    ),
    thumbCacheTtlDays: Number(process.env.CONTENT_BRIDGE_THUMB_CACHE_TTL_DAYS ?? '90'),
    cacheCapBytes: Number(
      process.env.CONTENT_BRIDGE_CACHE_CAP_BYTES ?? String(2_147_483_648)
    ),
    // Default state dir is derived from the managed root so it always lands in
    // the bridge-owned, writable area the cache already uses — never a separate
    // root-owned mount. Explicit CONTENT_BRIDGE_STATE_DIR overrides.
    stateDir:
      process.env.CONTENT_BRIDGE_STATE_DIR ??
      `${(process.env.CONTENT_BRIDGE_MANAGED_ROOT ?? '/data/managed').replace(/\/+$/, '')}/_state`,
    pairingCodePrefill: process.env.CONTENT_BRIDGE_PAIRING_CODE ?? '',
    forceWizard:
      (process.env.CONTENT_BRIDGE_FORCE_WIZARD ?? 'false').toLowerCase() === 'true',
    autoPair:
      (process.env.CONTENT_BRIDGE_AUTO_PAIR ?? 'false').toLowerCase() === 'true',
    setupUiLan:
      (process.env.CONTENT_BRIDGE_SETUP_UI_LAN ?? 'false').toLowerCase() === 'true',
    setupToken: process.env.CONTENT_BRIDGE_SETUP_TOKEN ?? '',
    setupUiHost: (process.env.CONTENT_BRIDGE_SETUP_UI_HOST ?? '').trim().toLowerCase(),
    appUrl:
      (process.env.CONTENT_BRIDGE_APP_URL ?? '').trim().replace(/\/+$/, '') || DEFAULT_APP_URL,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`bridge: invalid config; refusing to start:\n${issues}`);
    process.exit(1);
  }

  return parsed.data;
}
