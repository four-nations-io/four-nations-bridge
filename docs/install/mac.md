# Install the bridge on macOS

The bridge is a small background service that runs on your Mac, indexes your
content folder, and connects it to **your account** — your files stay on your
machine; the service only ever receives the file index, thumbnails, and short
previews.

What you need before starting:

- A **pairing code** — you generate this yourself in the app on the **Install
  Bridge** page (`/install-bridge`) when you're ready to pair (step 3)
- Your **content encryption key** (from your install instructions)
- ~10 minutes

## 1. Install Docker Desktop

The bridge runs inside Docker. If you don't have Docker Desktop yet:

1. Download it from <https://docs.docker.com/desktop/setup/install/mac-install/>
   (pick Apple Silicon or Intel to match your Mac).
2. Open the downloaded `.dmg`, drag Docker to Applications, and launch it once.
3. Wait until the whale icon in the menu bar stops animating.

> **Content on a NAS share?** If your content folder lives on a network share
> mounted under `/Volumes/...`, add it in Docker Desktop → **Settings →
> Resources → File sharing** first. Folders under `/Users` work out of the box.

## 2. Download and run the install script

Download both script files (the **Install Bridge** page in the app shows the
exact commands with your app's address already filled in), **look them over if
you like** (they're plain shell scripts), then run the macOS one:

<!-- TODO(V1-block: github-assets): for V0.9d `<release-url>` is the app's own
     /install path (e.g. https://your-app-domain/install); swap to the
     GitHub-released asset URL at V1.0 close. -->

```bash
curl -fsSLO <release-url>/install-mac.sh
curl -fsSLO <release-url>/install-common.sh
less install-mac.sh        # optional: inspect before running
bash install-mac.sh
```

The script will:

1. Check Docker Desktop is running
2. Pull the bridge image and **verify its publisher signature** (the install
   refuses to continue if verification fails — see [security.md](security.md))
3. Ask for your **content folder** (read-only — the bridge can never change it)
4. Ask where to keep the bridge's own files (default `~/four-nations-bridge`)
5. Ask for the service URL, pairing code, encryption key, and a **bridge name**
   (defaults to your Mac's hostname)
6. Ask **how you want to finish setup** — on a Mac just take the default
   (the on-this-Mac wizard); the headless auto-pair / LAN options exist for
   browser-less machines and you can leave them off
7. Start the bridge and print the setup-wizard address

## 3. Finish in the setup wizard

Open the address the script printed — **in a browser on this same Mac**:

```
http://localhost:8124
```

The wizard walks three steps:

1. **Pair with your account** — your pairing code is pre-filled if you gave it
   to the script; pick a name for this bridge (e.g. "Studio Mac")
2. **Confirm your content folder**
3. **Finish** — you'll see **"Your account is paired with this bridge"**

That's it. Close the window; the bridge keeps running in the background and
starts again automatically when Docker Desktop starts. Sign in to your account
from any device — phone, laptop, tablet — and your content library is there.
Pairing is account-level: there's nothing to set up per device.

## Everyday operations

| Task | How |
| --- | --- |
| Check the bridge | open `http://localhost:8124` (status page) |
| Stop / start | `cd ~/four-nations-bridge && docker compose stop` / `start` |
| Update to a new release | re-run `bash install-mac.sh` (pairing survives) |
| Re-pair (new code / different account) | see [security.md → Re-pairing](security.md#re-pairing) |
