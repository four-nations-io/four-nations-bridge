# four-nations-bridge

Cross-platform content bridge for the four-nations-web SaaS. Runs as a Docker container on the creator's own machine (NAS / Mac / PC), indexes content from whichever storage they keep it in, pushes file metadata + encrypted thumbnails + encrypted on-demand byte-range previews to the SaaS over an outbound-only WSS to `bridge.<saas-domain>`. **No full-file uploads.**

Built per [planning doc 46](../four-nations-web/docs/planning-docs/46-phase-f-desktop-content-bridge.md) (Phase F). Implements the Docker form-factor of the [arch-note 03](../four-nations-web/docs/architecture-notes/03-saas-content-bridge-and-helper.md) bridge protocol with **client-side end-to-end encryption** (Tier 3) — SaaS only ever sees ciphertext.

## Status

**Phase:** V0.1 (operator-only proof; soak week). The container starts, connects to bridge-gateway via WSS using a hardcoded V0 bearer, exchanges a `HELLO` frame, surfaces status in a minimal setup UI at `http://127.0.0.1:8123`. **No real frames yet** — V0.2 adds `INDEX_BATCH` (file index push), V0.3 adds `THUMB` (encrypted thumb push), V0.5 adds `READ_RESPONSE` (encrypted byte-range serving). V1 swaps the stub bearer + stub encryption key for real per-tenant pairing + Argon2-derived CEK.

See doc 46 §V0 build sequence for the full V0.1 → V0.6 plan.

## Repo layout

```
src/
  main.ts              entry — boots setup UI + WSS client
  config.ts            env loading + validation
  wss-client.ts        WSS handshake + HELLO frame (V0.1)
  setup-ui/
    server.ts          Express setup-UI server (V0.1: status page)
    public/            static HTML + CSS + JS for the setup UI
      index.html
      styles.css       vendored design tokens from four-nations-web
      app.js
scripts/
  copy-public-assets.mjs   build helper: copies setup-ui/public into dist/
```

## Local dev

```sh
npm install
npm run build
# Set CONTENT_BRIDGE_SAAS_URL + CONTENT_BRIDGE_BEARER + CONTENT_BRIDGE_DEVICE_LABEL in your env first
npm start
open http://127.0.0.1:8123
```

For end-to-end testing with the bridge-gateway service running on the NAS-dev compose stack:

```sh
cp .env.example .env
# edit .env — CONTENT_BRIDGE_BEARER (required), CONTENT_BRIDGE_HOST_CONTENT_PATH (required),
# and on Mac/PC also CONTENT_BRIDGE_SAAS_URL / DEVICE_LABEL / DEVICE_PLATFORM
docker compose up -d --build
docker compose logs -f
```

The `docker-compose.yml` in this folder is parameterized via env vars with NAS-deployment defaults. Mac + PC overrides come from the per-host `.env` (which is gitignored). On the NAS, Synology Container Manager picks up `docker-compose.yml` automatically when you import this folder as a project.

## Deployment (operator V0 targets)

Three deployment targets validated in V0.6 per doc 46:

1. **NAS** — sibling Docker compose stack to four-nations-web. Set `CONTENT_BRIDGE_DEVICE_LABEL=operator-nas`. Use `BRIDGE_SAAS_URL=ws://bridge-gateway:8080` (compose-network DNS) IF on the same compose network; otherwise use the LAN IP. Mount content path same as four-nations-next.
2. **Mac (Docker Desktop)** — `CONTENT_BRIDGE_DEVICE_LABEL=operator-mac`. Use `CONTENT_BRIDGE_SAAS_URL=ws://192.168.1.50:8080` (NAS LAN IP). Mount SMB-attached NAS share at `/Volumes/photo/Content/...:/sources/local:ro`.
3. **PC (Docker Desktop)** — `CONTENT_BRIDGE_DEVICE_LABEL=operator-pc`. Same `CONTENT_BRIDGE_SAAS_URL`. Mount SMB share with PC-syntax path.

## Architecture pointers

- Bridge protocol semantics, frame types, pairing flow, threat model: [arch-note 03](../four-nations-web/docs/architecture-notes/03-saas-content-bridge-and-helper.md).
- Container hardening (`cap_drop: ALL`, `read_only`, non-root, egress firewall, localhost-only setup UI): [arch-note 03 §Container hardening](../four-nations-web/docs/architecture-notes/03-saas-content-bridge-and-helper.md).
- Bridge-gateway service on SaaS side: [arch-note 09 §1](../four-nations-web/docs/architecture-notes/09-saas-deployment-artifacts.md).
- V0/V1/V2+ phasing, Tier 3 E2E architecture, source-plugin interface, multi-device routing: [doc 46](../four-nations-web/docs/planning-docs/46-phase-f-desktop-content-bridge.md).
- Per-device bearer chokepoint: `requireContentBridgeBearer` in [four-nations-web/next-app/src/lib/contentBridgeAuth.ts](../four-nations-web/next-app/src/lib/contentBridgeAuth.ts) — stable function name from V0 → V1+; only the body changes (V0 reads shared env bearer; V1.1 looks up per-device `bearer_hash` in `appsec.content_bridge_devices`).

## Pre-flight + standards

This project does **not** participate in the four-nations-web lefthook pre-commit hooks (tsc / lint / prettier / drift-check). It manages its own type-checking via `npm run build`. ESLint + Prettier wire up at V1.

The CLAUDE.md hard rules at the four-nations-web project root still apply for cross-project work — notably the "no personal names in any artifact" rule and the chokepoint discipline for bridge-bearer auth.

## License

Internal — see repo root.
