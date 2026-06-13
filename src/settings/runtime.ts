// Runtime settings — Phase F V0.4.
//
// V0.3 read all settings from env at boot (config.ts). V0.4 keeps env as the
// DEFAULT but overlays operator changes from the SaaS UI on top. Settings
// that the operator can change at runtime live in `appsec.content_bridge_settings`
// on the SaaS side; bridge polls via a WSS frame every 30s and overlays the
// values onto its in-memory runtime config.
//
// Live-applicable settings (change applies at next sync iteration):
//   - thumb_concurrency
//   - thumb_delay_ms
//   - thumb_subpath_within_project
//   - thumb_max_dim_px (V0.6.b)
//   - cache/proxy knobs: proxy_quality_crf, proxy_skip_below_bytes,
//     proxy_cache_ttl_minutes, thumb_cache_ttl_days, cache_cap_bytes (V0.6.b)
//
// Restart-required settings (NOT in the DB, env-only):
//   - saas_url, bearer, device_label, host_content_path, run_as_user,
//     encryption_key, setup_ui_port — changing these requires
//     `docker compose up -d --force-recreate` and a fresh container
//
// Source of truth for the orchestrator is `getRuntimeThumbSettings(state)`
// which returns env defaults merged with whatever the operator last
// configured via the SaaS UI.

import type { BridgeConfig } from '../config';

export interface RuntimeThumbSettings {
  concurrency: number;
  delayMs: number;
  subpathWithinProject: string;
  cpuNice: number;
  maxDimPx: number;
  jpegQuality: number;
}

/** V0.6.b cache + proxy knobs. Env defaults (config.ts) overlaid with operator
 *  overrides from the SaaS settings POST, same mechanism as the throttle knobs.
 *  Read once at the start of each orchestrator run / cache sweep. */
export interface RuntimeCacheSettings {
  proxyQualityCrf: number;
  proxySkipBelowBytes: number;
  proxyCacheTtlMinutes: number;
  thumbCacheTtlDays: number;
  cacheCapBytes: number;
}

/** V0.9c admin-plane quiet-hours window. Per-device, set from the SaaS admin
 *  control plane (stored in the same content_bridge_settings bag). During the
 *  window the daemon auto-pauses generation (thumbs/proxies/transcodes) so heavy
 *  ffmpeg work doesn't collide with scheduled NAS jobs (e.g. Hyper Backup).
 *  Evaluated against the daemon's LOCAL clock — the bridge runs on the creator's
 *  own machine, so its local time IS the creator's time. Byte-range READs are
 *  NOT gated (serving content keeps working while gen is paused). */
export interface RuntimeQuietHours {
  /** 'HH:MM' 24h local start (inclusive). */
  start: string;
  /** 'HH:MM' 24h local end (exclusive). end <= start ⇒ window wraps midnight. */
  end: string;
  /** Local weekdays the window applies to (0=Sun … 6=Sat). Empty ⇒ every day. */
  days: number[];
}

export interface RuntimeSettingsState {
  /** Last server-synced override values, keyed by setting key. Any keys
   *  not present here fall through to the env default in BridgeConfig. */
  overrides: Partial<RuntimeThumbSettings>;
  /** V0.6.b cache/proxy overrides (separate bag from the thumb-throttle
   *  overrides; same fall-through-to-env-default semantics). */
  cacheOverrides: Partial<RuntimeCacheSettings>;
  /** V0.9c admin-plane: manual pause (the SaaS "Pause bridge" action). Persisted
   *  as the `daemon_paused` setting so it survives a daemon restart and the SaaS
   *  can show it; a DAEMON_CONTROL pause/resume frame also flips it for instant
   *  effect (the next settings sync re-affirms it from the durable setting). */
  paused: boolean;
  /** V0.9c admin-plane: quiet-hours auto-pause window (null = disabled). */
  quietHours: RuntimeQuietHours | null;
  /** epoch ms of last successful settings pull from gateway. */
  lastSyncedAt: number | null;
  /** epoch ms of last attempted pull (success OR failure). */
  lastAttemptedAt: number | null;
  /** Error from the last failed pull, if any. Cleared on next success. */
  lastError: string | null;
  /** V0.6: operator-set default project-template folder (HOST path), overlaid
   *  on the env default. null = not set live (fall back to config). */
  defaultTemplatePath: string | null;
}

export function emptyRuntimeSettingsState(): RuntimeSettingsState {
  return {
    overrides: {},
    cacheOverrides: {},
    paused: false,
    quietHours: null,
    lastSyncedAt: null,
    lastAttemptedAt: null,
    lastError: null,
    defaultTemplatePath: null,
  };
}

/** Parse + validate an 'HH:MM' 24h time. Returns minutes-since-midnight or null. */
function parseHhMm(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Is `now` inside the quiet-hours window? Handles midnight-wrapping windows
 *  (end <= start) and the optional weekday filter. Both bounds + the weekday
 *  are read in LOCAL time (the bridge's own clock = the creator's clock). */
export function withinQuietHours(now: Date, qh: RuntimeQuietHours | null): boolean {
  if (!qh) return false;
  const start = parseHhMm(qh.start);
  const end = parseHhMm(qh.end);
  if (start === null || end === null) return false;
  if (start === end) return false; // empty/degenerate window ⇒ never paused
  const day = now.getDay();
  if (qh.days.length > 0 && !qh.days.includes(day)) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  if (start < end) {
    // Same-day window, e.g. 02:00–06:00.
    return mins >= start && mins < end;
  }
  // Wrapping window, e.g. 22:00–04:00 (covers late evening + early morning).
  return mins >= start || mins < end;
}

/** Effective gen-pause state: manual pause OR inside the quiet-hours window.
 *  The daemon's gen queue (runExclusive) checks this before running any thumb /
 *  proxy / transcode work; READ/LIST/SCAN paths are never gated. */
export function effectivePaused(state: RuntimeSettingsState, now: Date): boolean {
  return state.paused || withinQuietHours(now, state.quietHours);
}

/** Read effective thumb settings: env defaults merged with operator
 *  overrides (overrides win). */
export function effectiveThumbSettings(
  config: BridgeConfig,
  state: RuntimeSettingsState
): RuntimeThumbSettings {
  return {
    concurrency: state.overrides.concurrency ?? config.thumbConcurrency,
    delayMs: state.overrides.delayMs ?? config.thumbDelayMs,
    subpathWithinProject:
      state.overrides.subpathWithinProject ?? config.thumbSubpathWithinProject,
    cpuNice: state.overrides.cpuNice ?? config.thumbCpuNice,
    maxDimPx: state.overrides.maxDimPx ?? config.thumbMaxDimPx,
    jpegQuality: state.overrides.jpegQuality ?? config.thumbJpegQuality,
  };
}

/** Read effective cache/proxy settings: env defaults merged with operator
 *  overrides (overrides win). */
export function effectiveCacheSettings(
  config: BridgeConfig,
  state: RuntimeSettingsState
): RuntimeCacheSettings {
  return {
    proxyQualityCrf: state.cacheOverrides.proxyQualityCrf ?? config.proxyQualityCrf,
    proxySkipBelowBytes:
      state.cacheOverrides.proxySkipBelowBytes ?? config.proxySkipBelowBytes,
    proxyCacheTtlMinutes:
      state.cacheOverrides.proxyCacheTtlMinutes ?? config.proxyCacheTtlMinutes,
    thumbCacheTtlDays:
      state.cacheOverrides.thumbCacheTtlDays ?? config.thumbCacheTtlDays,
    cacheCapBytes: state.cacheOverrides.cacheCapBytes ?? config.cacheCapBytes,
  };
}

/**
 * Apply a server-side settings map to the runtime state. The server sends
 * each setting as `{ setting_key, setting_value }` JSON. Unknown keys are
 * silently ignored (forward-compat with future SaaS-side settings).
 */
export function applySettingsFromServer(
  state: RuntimeSettingsState,
  rawSettings: Array<{ setting_key: string; setting_value: unknown }>
): void {
  const next: Partial<RuntimeThumbSettings> = {};
  const nextCache: Partial<RuntimeCacheSettings> = {};
  let nextDefaultTemplatePath: string | null = null;
  // V0.9c admin-plane: pause + quiet-hours. Absent keys → defaults (not paused,
  // no window) so clearing the override on the SaaS side falls back cleanly.
  let nextPaused = false;
  let nextQuietHoursEnabled = false;
  let nextQuietStart = '';
  let nextQuietEnd = '';
  let nextQuietDays: number[] = [];
  // Clamp helper for the numeric cache knobs — the next-app validator already
  // bounds these, but the bridge re-clamps defensively (a compromised gateway
  // can't push an out-of-range value the bridge would act on).
  const clampInt = (v: unknown, min: number, max: number): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return Math.min(max, Math.max(min, Math.floor(v)));
  };
  for (const { setting_key, setting_value } of rawSettings) {
    switch (setting_key) {
      case 'default_template_path':
        // HOST path; empty string clears the override (falls back to env).
        if (typeof setting_value === 'string') {
          const trimmed = setting_value.trim();
          nextDefaultTemplatePath = trimmed.length > 0 ? trimmed : null;
        }
        break;
      case 'thumb_concurrency':
        if (typeof setting_value === 'number' && Number.isFinite(setting_value)) {
          next.concurrency = Math.max(1, Math.floor(setting_value));
        }
        break;
      case 'thumb_delay_ms':
        if (typeof setting_value === 'number' && Number.isFinite(setting_value)) {
          next.delayMs = Math.max(0, Math.floor(setting_value));
        }
        break;
      case 'thumb_subpath_within_project':
        if (
          typeof setting_value === 'string' &&
          setting_value.length > 0 &&
          !setting_value.startsWith('/') &&
          !setting_value.split('/').some((seg) => seg === '..')
        ) {
          next.subpathWithinProject = setting_value;
        }
        break;
      case 'thumb_max_dim_px': {
        // Live-overridable thumb resolution (operator 2026-06-05). 64–3840
        // (4K-width); bridge re-clamps as defense-in-depth.
        const v = clampInt(setting_value, 64, 3840);
        if (v !== null) next.maxDimPx = v;
        break;
      }
      // V0.6.b cache / proxy knobs. Bounds mirror config.ts + the next-app
      // settings validator; re-clamped here as defense-in-depth.
      case 'proxy_quality_crf': {
        const v = clampInt(setting_value, 18, 35);
        if (v !== null) nextCache.proxyQualityCrf = v;
        break;
      }
      case 'proxy_skip_below_bytes': {
        const v = clampInt(setting_value, 0, 10 * 1024 ** 3);
        if (v !== null) nextCache.proxySkipBelowBytes = v;
        break;
      }
      case 'proxy_cache_ttl_minutes': {
        const v = clampInt(setting_value, 1, 1440);
        if (v !== null) nextCache.proxyCacheTtlMinutes = v;
        break;
      }
      case 'thumb_cache_ttl_days': {
        const v = clampInt(setting_value, 1, 3650);
        if (v !== null) nextCache.thumbCacheTtlDays = v;
        break;
      }
      case 'cache_cap_bytes': {
        const v = clampInt(setting_value, 100 * 1024 ** 2, 100 * 1024 ** 3);
        if (v !== null) nextCache.cacheCapBytes = v;
        break;
      }
      // ── V0.9c admin-plane: pause + quiet-hours ──────────────────────────────
      case 'daemon_paused':
        // Manual "Pause bridge". Boolean; anything non-true reads as not paused.
        if (typeof setting_value === 'boolean') nextPaused = setting_value;
        break;
      case 'quiet_hours_enabled':
        if (typeof setting_value === 'boolean') nextQuietHoursEnabled = setting_value;
        break;
      case 'quiet_hours_start':
        // 'HH:MM'; re-validated when the window is assembled below.
        if (typeof setting_value === 'string') nextQuietStart = setting_value.trim();
        break;
      case 'quiet_hours_end':
        if (typeof setting_value === 'string') nextQuietEnd = setting_value.trim();
        break;
      case 'quiet_hours_days':
        // Array of weekday ints 0–6; ignore anything out of range / non-int.
        if (Array.isArray(setting_value)) {
          nextQuietDays = setting_value
            .filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)
            .filter((d, i, arr) => arr.indexOf(d) === i);
        }
        break;
      // Future: thumb_jpeg_quality, thumb_cpu_nice could also be DB-overridable.
      // V0.4 scoped to concurrency / delay / subpath; V0.6.b added the cache
      // knobs + thumb_max_dim_px; the rest stay env-only for now.
    }
  }
  state.overrides = next;
  state.cacheOverrides = nextCache;
  state.defaultTemplatePath = nextDefaultTemplatePath;
  state.paused = nextPaused;
  // Only assemble a window when enabled AND both bounds parse — otherwise null
  // (disabled). Bounds re-validated in withinQuietHours, so a malformed value
  // simply never pauses rather than throwing.
  state.quietHours =
    nextQuietHoursEnabled && parseHhMm(nextQuietStart) !== null && parseHhMm(nextQuietEnd) !== null
      ? { start: nextQuietStart, end: nextQuietEnd, days: nextQuietDays }
      : null;
  state.lastSyncedAt = Date.now();
  state.lastAttemptedAt = state.lastSyncedAt;
  state.lastError = null;
}
