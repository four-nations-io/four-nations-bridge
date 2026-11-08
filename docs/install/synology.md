# Install the bridge on a Synology NAS

The bridge is a small background service that runs on your NAS, indexes your
content shared folder, and connects it to **your account** — your files stay on
the NAS; the service only ever receives the file index, thumbnails, and short
previews.

What you need before starting:

- DSM **7.0 or newer** (7.2+ recommended)
- A **pairing code** — you generate this yourself in the app on the **Install
  Bridge** page (`/install-bridge`) when you're ready to pair
- Your **content encryption key** (from your install instructions)
- An administrator account on the NAS

## 1. Install Container Manager

Open **Package Center** and install:

- **Container Manager** (DSM 7.2+), or
- **Docker** (DSM 7.0 / 7.1 — same thing, older name)

## 2. Which user the bridge runs as (you don't need a new one)

You **don't** have to create a dedicated user. The installer **auto-detects the
user that owns your content** and runs the bridge as that user — it can read your
content, and your content is mounted **read-only**, so the bridge physically
cannot modify or delete it regardless of which user it runs as (the kernel mount
is the guarantee — see [security.md](security.md)). Just take the detected default
when the installer asks.

**Optional extra hardening.** If you'd like a *second*, independent layer — a
dedicated low-privilege user with read-only content access enforced by DSM's own
permission system — you can set one up and point the bridge at it. The installer
writes a step-by-step **`harden-account-prompt.txt`** in your install folder for
exactly this (create the user, grant read-only, reconfigure the bridge). The
classic recipe:

1. **Control Panel → User & Group → Create** — name `fournations-bridge`, strong
   random password, group `users` only.
2. **Shared-folder permissions**: your content share **Read only**, everything
   else **No access**. **Applications**: deny all.
3. Note its uid (`id fournations-bridge`, often `1031`), then set
   `CONTENT_BRIDGE_RUN_AS_USER` to it in the install folder's `.env`, chown the
   working folders to it, and `docker compose up -d`.

## 3. Enable SSH and run the install script

1. **Control Panel → Terminal & SNMP → Enable SSH service** (you can switch it
   back off after the install).
2. From your computer, download the two script files (the **Install Bridge** page
   in the app shows the exact download commands with your app's address filled
   in), copy them to the NAS, and connect:

The scripts come from the **public bridge repo at the release tag**, so what you download matches the
signed image of that same release:
`https://raw.githubusercontent.com/four-nations-io/four-nations-bridge/v<version>/scripts/…`.
⭐ The **Install Bridge** page fills the version in for you — it derives the tag from the current
release rather than carrying a hand-maintained pin, which had twice gone stale and sent creators
installers older than their image.

```bash
curl -fsSLO <release-url>/install-synology.sh
curl -fsSLO <release-url>/install-common.sh
scp install-synology.sh install-common.sh <admin>@<nas-ip>:/tmp/
ssh <admin>@<nas-ip>
sudo bash /tmp/install-synology.sh
```

The script will:

1. Check DSM version + Container Manager
2. Ask for your **content folder** (e.g. `/volume1/photo/Content`) — mounted
   **read-only**
3. **Auto-detect the user that owns that folder** and offer it as the run-as
   user (press Enter to accept, or type a different `uid:gid` — e.g. a dedicated
   user from the optional step 2)
4. Pull the bridge image and **verify its publisher signature** (hard stop on
   failure — see [security.md](security.md))
5. Ask where to keep the bridge's own files (default
   `/volume1/docker/four-nations-bridge`) and chown those working folders to the
   run-as user
6. Ask for the service URL, pairing code, encryption key, and a **bridge name**
   (defaults to the NAS's hostname)
7. Ask **how you want to finish setup** — because a NAS usually has no browser
   you can reach, this defaults to one of the no-browser options below
8. Start the container
9. Install a small **Synology Photos reindex service** so folders the bridge creates show up in
   Photos (see [below](#synology-photos-and-new-project-folders)) — nothing for you to do, and the
   install still succeeds without it if your DSM can't support it

## 4. Finish setup

A NAS is typically headless, so the installer offers two ways to finish without
reaching the NAS's `localhost`. It asks during step 7; pick whichever fits.

### Option A — Auto-pair on boot (simplest, recommended)

Answer **yes** to "Pair automatically on boot". The bridge verifies your pairing
code and pairs **itself** at startup — there's nothing to open. Watch it connect:

```bash
ssh <admin>@<nas-ip>
cd /volume1/docker/four-nations-bridge && sudo docker compose logs -f
```

Look for `auto-paired headlessly as "<your bridge name>"` followed by a HELLO
ack. That's it — your content starts appearing in your account.

### Option B — Finish from your laptop (LAN setup page)

Answer **yes** to "Enable LAN setup page" and give the NAS's LAN IP/hostname. The
installer prints a link with a one-time token:

```
http://192.168.1.50:8124/?token=<token>
```

Open it from any computer on your network and walk the wizard: confirm your
content folder, finish. The token is your access key — treat it like a password
and don't share the link. (It's stored in the install folder's `.env` as
`CONTENT_BRIDGE_SETUP_TOKEN` if you need it again.) See
[security.md → Pairing without a browser](security.md) for exactly what the token
protects.

### Option C — SSH tunnel (if you declined both)

The wizard is otherwise bound to the NAS's localhost. Tunnel to it:

```bash
ssh -L 8124:127.0.0.1:8124 <admin>@<nas-ip>
# then browse to http://localhost:8124
```

Whichever you pick, when the bridge shows **"Your account is paired with this
bridge"** you're done. The bridge keeps running and survives NAS reboots.

Sign in to your account from any device — phone, laptop, tablet — and your
content library is there. Pairing is account-level: nothing to set up per
device. If a partner uses the same NAS, they pair with their **own** account;
accounts are never shared.

## Synology Photos and new project folders

When Four Nations creates a project folder, it appears on disk immediately — but **Synology Photos will
not show it until Photos re-indexes.** The install sets up a small host-side task that handles this for
you, so a new folder shows up in Photos within a few seconds. You do not need to do anything.

If you ever need to trigger it by hand:

```sh
sudo /usr/syno/bin/synowebapi --exec api=SYNO.FotoTeam.Index method=reindex version=1
```

### Already running a bridge from before this existed?

A **new install** sets this up for you. So does **re-running the install script**, which is the
documented way to update — so if you update, you get it with no extra step.

⚠️ **Updating the container alone is not enough.** Pulling a newer image changes what runs *inside* the
container; it cannot create a root-owned service on the host. That is deliberate — see the boundary note
below. If you updated by bumping the image tag rather than re-running the installer, install just this
part:

```sh
sudo bash install-synology.sh --photos-reindex-only
```

It asks for your bridge's state folder (default `/volume1/docker/four-nations-bridge/managed/_state`),
or you can pass it directly:

```sh
sudo FN_STATE_DIR=/volume1/.../managed/_state bash install-synology.sh --photos-reindex-only
```

⛔ This mode **only** writes `/usr/local/bin/fn-photos-reindex.sh` and the systemd unit, then starts it.
It does not read or change your compose file, your `.env`, or the container — so it is safe to run from
a different copy of the scripts than the one your bridge was installed from.

### Checking it works

```sh
systemctl status fn-photos-reindex
```

Should read **active (running)**. Then create a project in the app and watch the two halves separately —
this is the split worth knowing, because a bridge that never signals and a service that never acts look
identical from Photos:

```sh
# 1. did the BRIDGE signal? (mtime should match when you created the folder)
ls -l /volume1/.../managed/_state/content-changed

# 2. did the HOST act?
journalctl -u fn-photos-reindex -n 20 --no-pager
```

| What you see | What it means |
| --- | --- |
| `reindex queued` | Working. Photos reconciles in the background, usually a few seconds. |
| `FATAL: synowebapi not executable` | A DSM update moved the binary. The service stops loudly rather than pretending. |
| `FAILED: reindex did not report success` | The API refused. The flag is **not** consumed, so it retries. |
| `REFUSING: ... is a symlink` | Should never happen — the bridge never creates one. Investigate. |
| No log line at all, and no flag file | The bridge isn't signalling. Check the container is on a release that includes it. |

### Removing it

```sh
sudo systemctl disable --now fn-photos-reindex
sudo rm -f /etc/systemd/system/fn-photos-reindex.service /usr/local/bin/fn-photos-reindex.sh
sudo rm -rf /var/lib/fn-photos-reindex
sudo systemctl daemon-reload
```

New folders then stay invisible in Photos until you re-index by hand, which is where things were before.

### Why it needs a host-side task at all

DSM's media indexer is notified by DSM's **own file services** — SMB, File Station — not by filesystem
events. A folder created over SMB appears in Photos instantly; the identical folder created by the
bridge writing to disk directly is never noticed. So the bridge writes a flag saying "I created
something", and a task running on the NAS triggers Photos' reindex.

⛔ **The bridge deliberately cannot do this itself.** `synowebapi` is mode `700 root:root` and
authenticates as `SYSTEM_ADMIN` purely by being root on the host. Mounting it into the container would
not grant "the ability to reindex Photos" — it would grant unauthenticated admin access to **every** DSM
Web API: users, shares, packages, certificates. The flag file is the security boundary: the container can
*ask*, and only the host can *act*. The worst a fully compromised bridge can do through that channel is
cause one extra reindex.

### ⛔ Do not try to fix this with `synoindex`

Measured on DSM 7, 2026-10-27. **Every one of these returned `exit=0` and had no effect:**

| Attempted | Result |
| --- | --- |
| `synoindex -A <dir>` ("add a dir") | exit 0, nothing |
| `synoindex -f -A <dir>` (file index) | exit 0, nothing |
| `synoindex -R <dir>` / `-R <parent>` / `-R photo` | exit 0, nothing |
| `synoindex -P SynologyPhotos -A <dir>` | exit 0, nothing |
| `synoindex -p MediaIndex -A <dir>` | exit 0, nothing |
| `indexfolder` | shared-folder granularity only (`SHARE_CREATE`/`REMOVE`/`RENAME`) |

`synoindex` writes the legacy **MediaIndex**. Synology Photos keeps its **own** Postgres index at
`/var/packages/SynologyPhotos/target/indexdb`, behind `pgbouncer`, and does not read MediaIndex. Those
commands were correctly updating an index Photos ignores — and reported success while doing so.

The only working lever is the Web API that Photos' own resync button calls, which is what the task uses.
`FotoTeam` is DSM's internal name for the Shared Space. The call is asynchronous: it returns in ~76 ms
having *queued* the scan, which then completes in a few seconds.

Two other things worth knowing, both measured: **empty folders index fine** (so this is not "Photos only
indexes media"), and **deletions propagate on their own** via `smbd` — creation from outside DSM's
services was always the only gap.

## Everyday operations

| Task | How |
| --- | --- |
| Check the container | Container Manager → Container → `four-nations-bridge` |
| Logs | Container Manager → Container → Details → Log |
| Stop / start | Container Manager, or `docker compose stop`/`start` in the install folder |
| Update to a new release | re-run the install script (pairing survives — and this also installs/refreshes the Photos reindex service) |
| Photos reindex service | `systemctl status fn-photos-reindex` · logs: `journalctl -u fn-photos-reindex` |
| New folders not showing in Photos | see [Checking it works](#checking-it-works) above |
| Re-pair | see [security.md → Re-pairing](security.md#re-pairing) |
