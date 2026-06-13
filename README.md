# four-nations-bridge

A self-hosted desktop bridge that connects a creator's local media library to
the **Four Nations** web app. It runs as a small Docker container on the machine
where the content already lives — a NAS, Mac, or PC — indexes that content
**read-only**, and streams only lightweight metadata to the web app: the file
index, encrypted thumbnails, and short encrypted preview streams.

**Your full files never leave your machine.** The bridge dials *outbound* over an
encrypted WebSocket; nothing dials in. Your content folder is mounted read-only,
so the bridge physically cannot modify or delete it. See
[docs/install/security.md](docs/install/security.md) for the full model.

## Status

The bridge is **V1** — functionally complete and in internal soak. Pairing is
account-level via single-use codes generated on the web app's **Install Bridge**
page: the code is exchanged for a per-device credential on first pair, so the
code itself is never the long-lived credential.

## Install

Generate a pairing code on the web app's **Install Bridge** page, then run the
installer for your platform:

- [macOS](docs/install/mac.md)
- [Linux](docs/install/linux.md)
- [Synology NAS](docs/install/synology.md)
- [Windows (WSL 2)](docs/install/windows.md)

Each installer pulls the published image, **verifies its signature** (below),
asks a few questions, generates the config, and starts the container.

## Verify the image yourself

Every release image is signed **keyless** with
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/)/Sigstore —
there is no signing key. The signature is tied to this repository's GitHub
release-workflow identity and recorded in the public Rekor transparency log. The
install scripts verify this automatically and hard-stop on failure. To check a
release by hand (cosign 2.x):

```bash
cosign verify \
  --certificate-identity-regexp '^https://github\.com/four-nations-io/four-nations-bridge/\.github/workflows/bridge-publish\.yml@refs/tags/v' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/four-nations-io/four-nations-bridge:<tag>
```

Install cosign:

- **macOS:** `brew install cosign`
- **Linux:** see the [cosign install guide](https://docs.sigstore.dev/cosign/system_config/installation/)
- **Windows:** `winget install sigstore.cosign` (or via the guide above)

## What's in this repository

```
src/                bridge daemon (TypeScript)
scripts/            installers (mac / linux / synology) + shared install logic
docs/install/       per-platform install guides + the security model
Dockerfile          multi-stage build (Node + ffmpeg + libvips)
.github/workflows/  build -> publish -> keyless-sign pipeline (bridge-publish.yml)
```

Images are published to `ghcr.io/four-nations-io/four-nations-bridge`
(`:latest` plus a `:X.Y.Z` tag per release).

## License

Proprietary — all rights reserved. Images are published so authorized users can
install and run the bridge against the Four Nations service; this does not grant
rights to copy, modify, or redistribute the source. See [LICENSE](LICENSE).
