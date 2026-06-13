// doc 59 Part 2 — bridge-side CHUNKED browser upload (resumable).
//
// A creator drags a file into the SaaS composer; the browser streams it as
// BINARY chunks → SaaS (requireUser) → bridge-gateway HTTP → bridge over WSS.
// This module receives those frames and assembles the file under the
// bridge-owned cache staging dir, then exposes it as a bridge://<dev>/cache/...
// ref the SaaS reads back at post time (read/stream.ts 'cache' base).
//
// Frames (gateway→bridge unless noted):
//   BROWSER_UPLOAD_START   (JSON)   { requestId, token, fileName, expectedBytes, chunkSize }
//     → bridge (re)creates a fresh empty .incoming/<token>.part temp + resets the
//       received-chunk set; replies START_RESULT { ok, receivedBytes: 0 }.
//   BROWSER_UPLOAD_CHUNK   (BINARY) [u32be headerLen][JSON {token,seq}][payload]
//     → written at offset seq×chunkSize (IDEMPOTENT — a re-sent chunk overwrites
//       the same bytes); the chunk index is added to receivedSeqs; replies
//       CHUNK_RESULT { token, seq, ok, receivedBytes }. Parallel/out-of-order safe.
//   BROWSER_UPLOAD_DONE    (JSON)   { requestId, token, sha256 }
//     → verify total bytes + sha256, atomic-rename into _twitterUploads/<final>,
//       reply DONE_RESULT { ok, cacheRelPath, stagedToken, relPath, byteLength }.
//   BROWSER_UPLOAD_STATUS  (JSON)   { requestId, token }  → STATUS_RESULT { ok, receivedBytes }
//   BROWSER_UPLOAD_ABORT   (JSON)   { token }             → delete temp + drop state
//
// SECURITY (mirrors file-upload.ts): the gateway is treated as untrusted. The
// `token` is validated to a strict charset, every write is realpath-confined to
// the .incoming dir, and the assembled file is moved only into the staging dir.
// Size is capped per-upload (BROWSER_UPLOAD_MAX_BYTES) as the absolute backstop —
// the SaaS enforces the per-(platform,file_type) hard_cap before the first chunk.

import { promises as fs } from "fs";
import { createReadStream } from "fs";
import path from "path";
import { createHash } from "crypto";
import type { WebSocket } from "ws";
import type { SharedState } from "./wss-client";
import {
  resolveCacheRoot,
  STAGING_DIRNAME,
  indexedRootContainerPath,
  safeBaseName,
} from "./file-upload";

/** Absolute per-upload backstop (app-wide 2GB hard cap; SaaS gates tighter). */
export const BROWSER_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Drop a stalled in-flight upload after this idle window (frees the temp). */
const UPLOAD_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const INCOMING_DIRNAME = ".incoming";
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

interface InflightUpload {
  fileName: string;
  expectedBytes: number;
  chunkSize: number;
  /** Chunk indices written so far. Parallel/out-of-order safe — completeness is
   *  size === expectedChunks, NOT a max-offset high-water (which would falsely
   *  pass if the last chunk lands while a middle one is still missing). */
  receivedSeqs: Set<number>;
  /** Sum of unique received chunk lengths (idempotent re-sends don't double-count). */
  receivedBytes: number;
  expectedChunks: number;
  tempPath: string;
  stagingDir: string;
  timer: NodeJS.Timeout;
}

const inflight = new Map<string, InflightUpload>();

interface StartFrame {
  type: "BROWSER_UPLOAD_START";
  requestId?: string;
  token?: string;
  fileName?: string;
  expectedBytes?: number;
  chunkSize?: number;
}
interface DoneFrame {
  type: "BROWSER_UPLOAD_DONE";
  requestId?: string;
  token?: string;
  sha256?: string;
}
interface StatusFrame {
  type: "BROWSER_UPLOAD_STATUS";
  requestId?: string;
  token?: string;
}
interface AbortFrame {
  type: "BROWSER_UPLOAD_ABORT";
  token?: string;
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // socket went away; the idle reaper will free the temp.
    }
  }
}

function clearInflight(token: string): void {
  const rec = inflight.get(token);
  if (rec) {
    clearTimeout(rec.timer);
    inflight.delete(token);
  }
}

function armIdleTimer(token: string): void {
  const rec = inflight.get(token);
  if (!rec) return;
  clearTimeout(rec.timer);
  rec.timer = setTimeout(() => {
    // Stalled upload — drop the temp so it can't linger. Best-effort.
    void fs.rm(rec.tempPath, { force: true }).catch(() => {});
    inflight.delete(token);
  }, UPLOAD_IDLE_TIMEOUT_MS);
  // Don't keep the process alive solely for the reaper.
  if (typeof rec.timer.unref === "function") rec.timer.unref();
}

async function confinedIncomingDir(
  state: SharedState,
): Promise<{ stagingDir: string; incomingDir: string } | null> {
  const cacheRoot = resolveCacheRoot(state);
  const stagingDir = path.posix.join(cacheRoot, STAGING_DIRNAME);
  const incomingDir = path.posix.join(stagingDir, INCOMING_DIRNAME);
  try {
    await fs.mkdir(incomingDir, { recursive: true });
    return { stagingDir, incomingDir };
  } catch {
    return null;
  }
}

export async function handleBrowserUploadStart(
  ws: WebSocket,
  state: SharedState,
  msg: StartFrame,
): Promise<void> {
  const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
  const token = String(msg.token ?? "");
  const reply = (payload: Record<string, unknown>): void =>
    sendJson(ws, {
      type: "BROWSER_UPLOAD_START_RESULT",
      requestId,
      token,
      ...payload,
    });

  if (!TOKEN_RE.test(token)) return reply({ ok: false, reason: "bad token" });
  const expectedBytes = Number(msg.expectedBytes);
  const chunkSize = Number(msg.chunkSize);
  if (
    !Number.isInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    expectedBytes > BROWSER_UPLOAD_MAX_BYTES
  ) {
    return reply({ ok: false, reason: "bad expectedBytes" });
  }
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize <= 0 ||
    chunkSize > 64 * 1024 * 1024
  ) {
    return reply({ ok: false, reason: "bad chunkSize" });
  }

  const dirs = await confinedIncomingDir(state);
  if (!dirs) return reply({ ok: false, reason: "cannot create staging dir" });
  let realIncoming: string;
  try {
    realIncoming = await fs.realpath(dirs.incomingDir);
  } catch {
    return reply({ ok: false, reason: "staging dir not reachable" });
  }
  const tempPath = path.join(realIncoming, `${token}.part`);
  if (path.dirname(tempPath) !== realIncoming) {
    return reply({ ok: false, reason: "invalid token path" });
  }

  // Fresh start: (re)create an empty temp. A brand-new upload gets a unique
  // token, so any pre-existing temp for THIS token is stale — truncate it. In-
  // flight resilience comes from per-chunk retry (the browser re-sends a dropped
  // chunk to its fixed offset), not from resuming a half-written temp here.
  try {
    await fs.writeFile(tempPath, "", { flag: "w" });
  } catch (err) {
    return reply({
      ok: false,
      reason: `cannot create temp: ${(err as Error).message}`,
    });
  }

  const existing = inflight.get(token);
  if (existing) clearTimeout(existing.timer);
  inflight.set(token, {
    fileName: typeof msg.fileName === "string" ? msg.fileName : "upload",
    expectedBytes,
    chunkSize,
    receivedSeqs: new Set<number>(),
    receivedBytes: 0,
    expectedChunks: Math.ceil(expectedBytes / chunkSize),
    tempPath,
    stagingDir: dirs.stagingDir,
    timer: setTimeout(() => {}, 0),
  });
  armIdleTimer(token);
  reply({ ok: true, receivedBytes: 0 });
}

/** Parse + apply a binary BROWSER_UPLOAD_CHUNK frame:
 *  [u32be headerLen][JSON {token, seq}][payload]. */
export async function handleBrowserUploadChunk(
  ws: WebSocket,
  buf: Buffer,
): Promise<void> {
  if (buf.length < 4) return;
  const headerLen = buf.readUInt32BE(0);
  if (headerLen <= 0 || headerLen > 4096 || 4 + headerLen > buf.length) return;
  let header: { token?: string; seq?: number };
  try {
    header = JSON.parse(buf.subarray(4, 4 + headerLen).toString("utf8"));
  } catch {
    return;
  }
  const token = String(header.token ?? "");
  const seq = Number(header.seq);
  const payload = buf.subarray(4 + headerLen);
  const reply = (payload2: Record<string, unknown>): void =>
    sendJson(ws, {
      type: "BROWSER_UPLOAD_CHUNK_RESULT",
      token,
      seq,
      ...payload2,
    });

  if (!TOKEN_RE.test(token) || !Number.isInteger(seq) || seq < 0) {
    return reply({ ok: false, reason: "bad chunk header" });
  }
  const rec = inflight.get(token);
  if (!rec) return reply({ ok: false, reason: "no-session" }); // browser re-STARTs (idempotent)
  if (payload.length === 0 || payload.length > rec.chunkSize) {
    return reply({ ok: false, reason: "bad chunk size" });
  }
  const offset = seq * rec.chunkSize;
  if (offset + payload.length > rec.expectedBytes) {
    return reply({ ok: false, reason: "chunk past end" });
  }

  let fh: import("fs").promises.FileHandle | null = null;
  try {
    fh = await fs.open(rec.tempPath, "r+");
    await fh.write(payload, 0, payload.length, offset);
  } catch (err) {
    return reply({
      ok: false,
      reason: `write failed: ${(err as Error).message}`,
    });
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  // Count each chunk index once (idempotent re-sends don't inflate the total).
  if (!rec.receivedSeqs.has(seq)) {
    rec.receivedSeqs.add(seq);
    rec.receivedBytes += payload.length;
  }
  armIdleTimer(token);
  reply({ ok: true, receivedBytes: rec.receivedBytes });
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function handleBrowserUploadDone(
  ws: WebSocket,
  state: SharedState,
  msg: DoneFrame,
): Promise<void> {
  const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
  const token = String(msg.token ?? "");
  const reply = (payload: Record<string, unknown>): void =>
    sendJson(ws, {
      type: "BROWSER_UPLOAD_DONE_RESULT",
      requestId,
      token,
      ...payload,
    });

  if (!TOKEN_RE.test(token)) return reply({ ok: false, reason: "bad token" });
  const rec = inflight.get(token);
  if (!rec) return reply({ ok: false, reason: "no-session" });

  if (
    rec.receivedSeqs.size !== rec.expectedChunks ||
    rec.receivedBytes !== rec.expectedBytes
  ) {
    return reply({
      ok: false,
      reason: "incomplete",
      receivedBytes: rec.receivedBytes,
      expectedBytes: rec.expectedBytes,
    });
  }

  // Integrity: declared sha256 (if any) must match the assembled file.
  if (typeof msg.sha256 === "string" && msg.sha256) {
    let actual: string;
    try {
      actual = await sha256File(rec.tempPath);
    } catch (err) {
      return reply({
        ok: false,
        reason: `hash failed: ${(err as Error).message}`,
      });
    }
    if (actual.toLowerCase() !== msg.sha256.toLowerCase()) {
      await fs.rm(rec.tempPath, { force: true }).catch(() => {});
      clearInflight(token);
      return reply({ ok: false, reason: "sha256 mismatch" });
    }
  }

  // Atomic publish: rename .incoming/<token>.part → _twitterUploads/<token>__<name>.
  const finalName = `${token}__${safeBaseName(rec.fileName)}`;
  const finalPath = path.join(rec.stagingDir, finalName);
  try {
    const realStaging = await fs.realpath(rec.stagingDir);
    if (path.dirname(finalPath) !== realStaging) {
      return reply({ ok: false, reason: "invalid final path" });
    }
    await fs.rename(rec.tempPath, finalPath);
  } catch (err) {
    return reply({
      ok: false,
      reason: `publish failed: ${(err as Error).message}`,
    });
  }

  // CONTENT_ROOT-relative path (back-compat read), when the cache sits under the
  // indexed content root — mirrors file-upload.ts.
  let relPath: string | null = null;
  const contentRoot = indexedRootContainerPath(state);
  if (contentRoot) {
    try {
      const realContentRoot = await fs.realpath(contentRoot);
      if (
        finalPath === realContentRoot ||
        finalPath.startsWith(realContentRoot + path.sep)
      ) {
        relPath = path.posix.normalize(
          finalPath
            .slice(realContentRoot.length)
            .replace(/\\/g, "/")
            .replace(/^\/+/, ""),
        );
      }
    } catch {
      relPath = null;
    }
  }

  const stagedToken = `${STAGING_DIRNAME}/${finalName}`;
  clearInflight(token);
  reply({
    ok: true,
    cacheRelPath: stagedToken, // bridge://<dev>/cache/<this> — the canonical read ref
    stagedToken, // for DELETE_FILE after the post
    relPath, // CONTENT_ROOT-relative (null if cache outside the content tree)
    byteLength: rec.expectedBytes,
  });
}

export async function handleBrowserUploadStatus(
  ws: WebSocket,
  state: SharedState,
  msg: StatusFrame,
): Promise<void> {
  const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
  const token = String(msg.token ?? "");
  const reply = (payload: Record<string, unknown>): void =>
    sendJson(ws, {
      type: "BROWSER_UPLOAD_STATUS_RESULT",
      requestId,
      token,
      ...payload,
    });
  if (!TOKEN_RE.test(token)) return reply({ ok: false, reason: "bad token" });

  const rec = inflight.get(token);
  if (rec)
    return reply({ ok: true, found: true, receivedBytes: rec.receivedBytes });
  // Not in memory — check disk (process restarted mid-upload).
  const dirs = await confinedIncomingDir(state);
  if (dirs) {
    try {
      const st = await fs.stat(path.join(dirs.incomingDir, `${token}.part`));
      return reply({ ok: true, found: true, receivedBytes: st.size });
    } catch {
      // not found
    }
  }
  reply({ ok: true, found: false, receivedBytes: 0 });
}

export async function handleBrowserUploadAbort(
  state: SharedState,
  msg: AbortFrame,
): Promise<void> {
  const token = String(msg.token ?? "");
  if (!TOKEN_RE.test(token)) return;
  const rec = inflight.get(token);
  if (rec) {
    await fs.rm(rec.tempPath, { force: true }).catch(() => {});
    clearInflight(token);
    return;
  }
  const dirs = await confinedIncomingDir(state);
  if (dirs) {
    await fs
      .rm(path.join(dirs.incomingDir, `${token}.part`), { force: true })
      .catch(() => {});
  }
}
