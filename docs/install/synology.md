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

<!-- TODO(V1-block: github-assets): for V0.9d the scripts download from the app's
     own /install path (e.g. https://your-app-domain/install/install-synology.sh);
     swap to the GitHub-released asset URL at V1.0 close. -->

```bash
curl -fsSLO <release-url>/install-synology.sh
curl -fsSLO <release-url>/install-common.sh
scp install-synology.sh install-common.sh <admin>@<nas-ip>:/tmp/
ssh <admin>@<nas-ip>
sudo bash /tmp/install-synology.sh
```

The script will:

1. Check DSM version + Container Manager
2. Ask for your **content folder** (e.g. `/volume1/Media/Content`) — mounted
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
http://192.168.1.20:8124/?token=<token>
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

## Everyday operations

| Task | How |
| --- | --- |
| Check the container | Container Manager → Container → `four-nations-bridge` |
| Logs | Container Manager → Container → Details → Log |
| Stop / start | Container Manager, or `docker compose stop`/`start` in the install folder |
| Update to a new release | re-run the install script (pairing survives) |
| Re-pair | see [security.md → Re-pairing](security.md#re-pairing) |
