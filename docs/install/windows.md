# Install the bridge on Windows

The bridge is a small background service that runs on your Windows PC, indexes
your content folder, and connects it to **your account** — your files stay on
your machine; the service only ever receives the file index, thumbnails, and
short previews.

Windows runs the bridge inside **WSL 2** — the same Linux engine Docker Desktop
already uses — so the install is the tested, signature-verified Linux installer
run from your WSL distro. There's no separate Windows program to maintain, and
you get the exact same supply-chain check (the install stops if the image
signature doesn't verify — see [security.md](security.md)).

What you need before starting:

- Windows 10/11 with **WSL 2** available
- A **pairing code** — you generate this yourself in the app on the **Install
  Bridge** page (`/install-bridge`) when you're ready to pair
- Your **content encryption key** (from your install instructions)
- ~15 minutes

## 1. Install Docker Desktop with WSL 2

1. Install Docker Desktop:
   <https://docs.docker.com/desktop/setup/install/windows-install/> — choose the
   **WSL 2 backend** when prompted (it's the default; reboot if asked).
2. Launch Docker Desktop once and wait until it reports **Running**.
3. In **Settings → Resources → WSL integration**, enable integration for your
   Linux distro (e.g. Ubuntu). If you don't have a distro yet, install one from
   the Microsoft Store (Ubuntu is the simplest), open it once to finish setup,
   then enable it here.

## 2. Run the installer inside WSL

Open your WSL distro's terminal (search "Ubuntu" in the Start menu), then
download and run the Linux installer there. Inspect the scripts first if you
like — they're plain shell.

<!-- TODO(V1-block: github-assets): for V0.9d `<release-url>` is the app's own
     /install path (e.g. https://your-app-domain/install); swap to the
     GitHub-released asset URL at V1.0 close. -->

```bash
curl -fsSLO <release-url>/install-linux.sh
curl -fsSLO <release-url>/install-common.sh
less install-linux.sh      # optional: inspect before running
bash install-linux.sh
```

When the installer asks for your **content folder**, give it a path your WSL
distro can see. Your Windows drives are mounted under `/mnt/` — for example
`C:\Users\you\Content` is `/mnt/c/Users/you/Content`. The installer mounts that
folder **read-only**, so the bridge can never change or delete anything in it.

The installer will:

1. Check Docker + Compose v2 (provided by Docker Desktop's WSL integration)
2. Pull the bridge image and **verify its publisher signature** (hard stop on
   failure)
3. Ask for your content folder, service URL, pairing code, encryption key, and a
   **bridge name** (defaults to this machine's name)
4. Start the container and print the setup-wizard address

## 3. Finish in the setup wizard

Open the address the installer printed — in a browser **on this PC**:

```
http://localhost:8124
```

The wizard walks three steps: pair with your account (paste the pairing code you
generated in the app, and pick a name for this bridge), confirm your content
folder, finish. When it shows **"Your account is paired with this bridge"**
you're done — close the window; the bridge keeps running.

Sign in to your account from any device — phone, laptop, tablet — and your
content library is there. Pairing is account-level: there's nothing to set up
per device. A partner pairs with their **own** account; accounts are never
shared.

## Manual alternative (no WSL installer)

If you'd rather not run the installer, you can run the same container by hand:
keep Docker Desktop + WSL 2 running, place a `docker-compose.yml` and a `.env`
(content folder path, service URL, pairing code, encryption key) in a folder,
then `docker compose up -d` and open `http://localhost:8124` to pair. The
installer above just generates those two files for you — running it inside WSL
is the supported, signature-checked path and is recommended.

## Everyday operations

| Task | How |
| --- | --- |
| Check the bridge | open `http://localhost:8124` (status page) |
| Logs | `docker logs four-nations-bridge` (in WSL) |
| Stop / start | `cd ~/four-nations-bridge && docker compose stop` / `start` (in WSL) |
| Update to a new release | re-run `bash install-linux.sh` (pairing survives) |
| Re-pair | see [security.md → Re-pairing](security.md#re-pairing) |
