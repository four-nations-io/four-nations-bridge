# Bridge security model

This doc explains what protects your content when you run the bridge, in plain
terms, and what to do for re-pairing or verifying a release yourself. It
applies to all platforms (Mac / Synology / Linux); the per-platform docs link
here.

The one-sentence version: **your content never leaves your machine as full
files, the bridge physically cannot modify or delete it, and the install only
runs software whose publisher signature verifies.**

## What the service receives (and what it never does)

The bridge connects *outbound* to the service over an encrypted WebSocket. The
service receives:

- the **file index** (names, sizes, dates, folder structure of your content)
- **thumbnails** and short **preview streams**, encrypted on your machine with
  your content encryption key before they leave it

The service never receives or stores your full files. There is no inbound
connection to your machine — the bridge dials out, nothing dials in.

## The mount boundary model

The bridge runs in a container with three deliberately different views of your
disk:

| Mount | Access | What it's for |
| --- | --- | --- |
| Your content folder | **read-only** | indexing, thumbnails, previews |
| Bridge cache folder | read-write | generated thumbnails/previews (evictable, bridge-owned) |
| Bridge managed folder | read-write, **add-only in code** | optional project-folder creation |

"Read-only" here is enforced by the **operating-system kernel** (the Docker
mount), not by bridge code. Even a hypothetical full compromise of the bridge
process cannot write to, tamper with, or ransomware your content folder — the
container's view of it is physically read-only.

Because of that, you **don't need a dedicated user** to keep your content safe:
the installer simply runs the bridge as the user that already owns your content,
and the read-only mount blocks writes regardless of which user that is. A
dedicated low-privilege user (with a **Read only** share permission of its own)
is an **optional second, independent layer** of the same guarantee — worth it on
a shared NAS, unnecessary for a solo creator pointing at their own folder. The
installer writes a `harden-account-prompt.txt` if you want to set one up later.

Defense in depth on top of the kernel boundary:

- the container runs as a **non-root user**, with all Linux capabilities
  dropped and privilege escalation disabled (`no-new-privileges`)
- the container filesystem itself is read-only; only the bridge-owned folders
  above are writable
- the bridge's entire write surface in code is *copy* and *create-folder* —
  there is no delete/rename/overwrite code path for content, and the bridge
  rate-limits its own create operations so even a malicious server can only
  request a bounded number of folder creations
- the wizard/status page binds to **127.0.0.1 only** by default, validates the
  Host header (blocks DNS-rebinding tricks), and rate-limits pairing attempts.
  If you opt into the **LAN setup page** (to finish setup from another computer),
  it binds to the network instead but then **requires a one-time token on every
  request** and only accepts private-network Host headers — and if the token is
  somehow missing it refuses every off-box request rather than opening up (it
  *fails closed*). See "Pairing without a browser" below.

## What a fully-compromised service could and couldn't do

Worst-case framing — suppose an attacker fully controls the service (the
cloud side):

**Could:** read the metadata you already share with the service (file index,
thumbnails, previews); ask the bridge to create a bounded number of new
folders inside your one writable bridge folder.

**Could not:** read folders you never chose to expose (the kernel mount means
the bridge cannot see them, so neither can the attacker); delete or modify any
content; widen the bridge's view of your disk (adding a folder requires *you*
to run a command/installer on *your* machine — the server can only ask);
push code to your machine (releases are pull-based and signature-verified).

## Release signing — what verification gives you

Every published bridge image is signed at build time **keyless** with
cosign/Sigstore: the publisher's release workflow on GitHub signs the image
under a short-lived certificate tied to its GitHub identity (there is no
long-lived signing key), and the signature is recorded in the public **Rekor**
transparency log. The install script:

1. pulls the image and resolves its immutable **digest** (content hash)
2. verifies the signature **of that digest** comes from the expected signer
   identity (the publisher's release workflow) under GitHub's OIDC issuer
3. pins the generated config to the digest — what runs is exactly what was
   verified

If verification fails the install **stops**. It does not warn-and-continue.
A failure means the image in the registry is not one the publisher signed —
that defeats an attacker who compromises the registry itself (they can push an
image, but they can't produce a signature that verifies as the publisher).

Honest limits: signing does **not** protect against a compromise of the
publisher's own build pipeline or GitHub org — that's a different attack class.
Keyless removes the long-lived signing key as a thing that can leak, and every
signature is publicly auditable in the Rekor transparency log; neither is a
control that runs on your machine.

Verify a release manually any time (cosign 2.x):

```bash
cosign verify \
  --certificate-identity-regexp '^https://github\.com/four-nations-io/four-nations-bridge/\.github/workflows/bridge-publish\.yml@refs/tags/v' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/four-nations-io/four-nations-bridge:<tag>
```

## About `curl | sh` (and why we don't ask for it)

Piping a downloaded script straight into a shell means running code you never
looked at, and a malicious or compromised download server could even serve
different content to `curl` than to your browser. The install docs therefore
use **download → (optionally) inspect → run**:

```bash
curl -fsSLO <release-url>/install-mac.sh      # download to a file
less install-mac.sh                            # read it — it's short
bash install-mac.sh                            # then run it
```

The scripts are deliberately plain shell with no obfuscation. The image
signature check above is the backstop either way: even a tampered script can't
make a forged image pass verification — though a tampered script could do
plenty else, which is why downloading scripts only from the official release
location matters.

## Pairing — account-level, and how to re-pair

Pairing connects this bridge to **your account** — not to a browser or a
device. Sign in anywhere and your content library is available; a partner
pairs with their *own* account. The pairing credential is stored only on your
machine, in the bridge's managed folder (`managed/_state/paired.json`,
owner-readable only).

You generate the pairing code yourself, in the app, on the **Install Bridge**
page (`/install-bridge`). Each code is tied to **your account**, has a limited
lifetime (it stops being usable for new pairings after it expires), and can be
revoked from that same page if you decide not to use it. The code is shown to
you exactly once when you generate it — treat it like a password.

<a id="re-pairing"></a>
**Re-pair** (new pairing code, or pairing to a different account):

```bash
cd <your-install-folder>            # e.g. ~/four-nations-bridge
rm managed/_state/paired.json       # forget the old pairing (this machine only)
docker compose restart
```

Then open `http://localhost:8124` — the setup wizard is active again whenever
the bridge is unpaired. Treat a pairing code like a password: if you think one
leaked, ask for it to be rotated, then re-pair with the new one.

Because the pairing's stable identity (`deviceKey`) lives in `paired.json` inside
the managed folder — **with** your content, not in the bridge's typed name —
rebuilding or renaming the bridge at the **same** managed path re-attaches to the
same device and the same already-indexed content. Wiping the managed folder (or
deleting `paired.json`) is what forces a fresh pairing.

## Pairing without a browser (headless NAS / another computer)

If the machine running the bridge has no browser you can reach (a NAS), the
installer offers two ways to pair that don't need `localhost` access. They're
mutually exclusive — the installer picks one with you.

**Auto-pair on boot** — the simplest. You paste your pairing code during install
and the bridge verifies it with the service and pairs **itself** at startup. No
page to open. The code is stored only in your install folder's `.env` (mode 600)
and in `paired.json`; you can blank it from `.env` after pairing if you like.
A wrong code or name stops with a clear log line (it never crash-loops); a
service that's briefly unreachable is retried, including on the next restart.

**LAN setup page** — finish setup from your laptop. The installer exposes the
wizard on your network **protected by a generated one-time token** and hands you
a link like `http://192.168.1.20:8124/?token=…`. Properties:

- every request to the LAN page must carry that token (the link carries it once;
  the page then keeps it in memory and drops it from the address bar)
- only private-network addresses are accepted as the page's host — a public
  domain pointed at your NAS's IP is still rejected (anti-DNS-rebinding)
- if the token is ever missing while LAN mode is on, the page refuses **every**
  off-box request (503) rather than opening unauthenticated — it *fails closed*
- the container's own health check uses loopback, so it keeps working regardless

Treat the token like the pairing code — it's in your `.env` as
`CONTENT_BRIDGE_SETUP_TOKEN` if you need it again. Once paired, the wizard (and
so the token) stop doing anything: every setup route returns 404 on a paired
bridge. To turn the LAN page off afterward, set `CONTENT_BRIDGE_SETUP_UI_BIND`
back to `127.0.0.1` (and `CONTENT_BRIDGE_SETUP_UI_LAN=false`) and restart.

## Operational controls on the service side

Beyond the per-machine guarantees above, the service runs a few controls that
bound a bridge's blast radius even in normal operation:

- **Per-tenant egress cap** — the volume a bridge can serve out is capped, so a
  runaway or hijacked browser session can't quietly exfiltrate your whole library
  through preview reads.
- **Admin control plane** — a super-admin surface can pause a bridge, stop its
  in-flight transcodes/previews, and arm a re-pair for a relocated bridge. These
  are management controls, not a way to read your content (the encryption boundary
  still holds).

## Current hardening status (transparency)

The bridge is in its V1 hardening arc.

- **Pairing uses single-use codes + a per-device credential.** The code you
  generate in the app is a one-time claim ticket: the first time your bridge uses
  it, the service consumes it and issues your bridge its own distinct credential,
  which is what the bridge stores and reconnects with. The code itself is never
  the long-lived credential — so the value that passed through your screen /
  clipboard during setup stops being useful the moment your bridge pairs, and the
  durable credential never leaves the service↔bridge channel. A used or expired
  code can't pair anything; generate a fresh one if you need to pair again. This
  replaces the earlier model where a single shared credential was distributed by
  hand.

Accepted-and-tracked item:

- the content encryption key is delivered with the install instructions today;
  a future release derives it during pairing instead, so nothing key-like
  travels alongside the code

Neither weakens the mount-boundary guarantees above — they bound what the
*service* can know, not what it can *do* to your files.
