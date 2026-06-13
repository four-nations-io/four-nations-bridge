# Install the bridge on Linux

The bridge is a small background service that runs on your Linux machine or
home server, indexes your content folder, and connects it to **your account** —
your files stay on your machine; the service only ever receives the file index,
thumbnails, and short previews.

What you need before starting:

- A **pairing code** — you generate this yourself in the app on the **Install
  Bridge** page (`/install-bridge`) when you're ready to pair
- Your **content encryption key** (from your install instructions)
- A user account that can run Docker (in the `docker` group), with **read**
  access to your content folder

## 1. Install Docker Engine

Follow the official instructions for your distribution:
<https://docs.docker.com/engine/install/> — including the
[post-install step](https://docs.docker.com/engine/install/linux-postinstall/)
that adds your user to the `docker` group (the installer expects to run as a
normal user, not root). Docker Compose v2 ships with current Docker Engine
packages (`docker compose version` should work).

## 2. Download and run the install script

Download both script files (the **Install Bridge** page in the app shows the
exact commands with your app's address already filled in), **inspect them if
you like** (plain shell), then run:

<!-- TODO(V1-block: github-assets): for V0.9d `<release-url>` is the app's own
     /install path (e.g. https://your-app-domain/install); swap to the
     GitHub-released asset URL at V1.0 close. -->

```bash
curl -fsSLO <release-url>/install-linux.sh
curl -fsSLO <release-url>/install-common.sh
less install-linux.sh      # optional: inspect before running
bash install-linux.sh
```

The script will:

1. Check Docker + Compose v2
2. Pull the bridge image and **verify its publisher signature** (hard stop on
   failure — see [security.md](security.md))
3. Ask for your **content folder** (mounted read-only — the bridge can never
   change or delete anything in it)
4. Ask where to keep the bridge's own files (default `~/four-nations-bridge`)
5. Ask for the service URL, pairing code, encryption key, and a **bridge name**
   (defaults to this machine's hostname)
6. Ask **how you want to finish setup** (see below) — defaults to the on-this-
   machine wizard
7. Start the container **as your uid:gid** — it only needs read on your
   content; everything it writes stays in its own folders

## 3. Finish setup

On a desktop, just open the wizard **in a browser on this same machine**:

```
http://localhost:8124
```

The wizard walks three steps: pair with your account (code + a name for this
bridge), confirm your content folder, finish. When it shows **"Your account is
paired with this bridge"** you're done — close the window; the bridge keeps
running and restarts with Docker.

**Headless box (no local browser)?** The installer offers two no-tunnel options
during step 6:

- **Auto-pair on boot** — the bridge pairs itself from your pairing code at
  startup; nothing to open. Watch `docker logs -f four-nations-bridge` for
  `auto-paired headlessly`.
- **LAN setup page** — finish from your laptop via a tokenized link the
  installer prints (`http://<this-ip>:8124/?token=…`). The token is required on
  every request and the page fails closed without it — see
  [security.md → Pairing without a browser](security.md).

(You can still use the old `ssh -L 8124:127.0.0.1:8124 you@server` tunnel if you
prefer the localhost wizard.)

Sign in to your account from any device and your content library is there —
pairing is account-level, nothing to set up per device.

## Everyday operations

| Task | How |
| --- | --- |
| Check the bridge | `http://localhost:8124` (status page) |
| Logs | `docker logs four-nations-bridge` |
| Stop / start | `cd ~/four-nations-bridge && docker compose stop` / `start` |
| Update to a new release | re-run `bash install-linux.sh` (pairing survives) |
| Re-pair | see [security.md → Re-pairing](security.md#re-pairing) |
