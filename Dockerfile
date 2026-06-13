# four-nations-bridge — Phase F V0.3.
#
# Multi-stage build:
#   - Stage 1 (builder): installs all deps (incl. devDeps like typescript),
#     compiles TS → JS, copies static setup-ui assets into dist/.
#   - Stage 2 (runtime): installs prod deps only, copies the built dist/ in,
#     plus apk-installs ffmpeg (V0.3 thumbnail extraction) and the vips
#     runtime that sharp links against.
#
# V0.3 adds: ffmpeg for video frame extraction, sharp (prebuilt for
# linux-musl-x64) for image resize + JPEG encode.

# ─── Stage 1: build ────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# sharp's musl prebuilt binary needs libvips at build time only when it
# falls back to source build. vips-dev includes both runtime + headers.
RUN apk add --no-cache vips-dev python3 make g++

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN npx tsc -p tsconfig.json && node scripts/copy-public-assets.mjs

# ─── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:24-alpine

WORKDIR /app

# Runtime needs:
#   - ffmpeg + ffprobe for V0.3 video thumbnail extraction (fluent-ffmpeg
#     wraps the system binary).
#   - vips for sharp's image resize + JPEG encode at runtime.
#   - tini as PID 1 so ffmpeg children get cleaned up on SIGTERM.
RUN apk add --no-cache ffmpeg vips tini

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi

COPY --from=builder /app/dist ./dist

# Run as non-root, with a fixed default UID 1031 / GID 100. Override at runtime
# (compose `user:` or the install scripts) to match the user that owns your
# content, so the read-only content mount is readable.
USER 1031:100

ENV NODE_ENV=production

# Setup UI port — bound to 127.0.0.1 in the compose template, never 0.0.0.0,
# per arch-note 03 §Container hardening.
EXPOSE 8123

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
