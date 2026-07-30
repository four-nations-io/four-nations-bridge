# Install the bridge on Windows

The bridge is a small background service that runs on your Windows PC, indexes
your content folder, and connects it to **your account** — your files stay on
your machine; the service only ever receives the file index, thumbnails, and
short previews.

**The setup wizard in the app is the supported way to install.** It is click,
copy and paste: it builds your two setup files for you, and there is exactly one
command to run. You do **not** need Ubuntu, WSL, or any Linux app — `docker
compose` runs natively in PowerShell through Docker Desktop.

Open the app, go to **Install Bridge**, and follow it. This page is the written
version of the same steps, plus the manual alternative.

What you need before starting:

- Windows 10/11 with **Docker Desktop**
- A **pairing key** — the wizard creates it for you. That one key is all you
  need; the content key is delivered automatically when you pair.
- ~10 minutes

## 1. Install Docker Desktop

1. Install Docker Desktop:
   <https://docs.docker.com/desktop/setup/install/windows-install/>. It sets up
   its own engine automatically (reboot if it asks).
2. Launch it once and wait until it reports **Running**.
3. In **Settings → General**, turn on **"Start Docker Desktop when you sign
   in"** so the bridge comes back on its own after you restart your PC.

## 2. Download your setup files

In the app's Install Bridge wizard, tell it where your content lives, then press
**Download**. You get `four-nations-bridge.zip` containing `docker-compose.yml`
and `bridge.env`.

**Getting your content folder path:** in File Explorer, hold **Shift**,
right-click the folder, and choose **"Copy as path"**. Paste that straight into
the wizard — quotes, backslashes and all. The wizard tidies it into the form the
bridge needs (`C:/Users/you/Videos`); there is nothing to edit by hand.

Content on an **external or network drive** must first be added under Docker
Desktop → Settings → Resources → File sharing. Folders on another computer
(`\\server\share`) are not supported yet — copy the content onto this PC, or use
a folder on a drive Docker Desktop can share.

Right-click the `.zip` → **Extract All** → **Extract**. You get a
`four-nations-bridge` folder with both files already inside.

## 3. Run one command

Open that folder in File Explorer, click the **address bar** at the top, type
`powershell`, and press **Enter**. PowerShell opens already pointed at the
folder, so there is no path to type. Then paste:

```powershell
docker compose --env-file bridge.env up -d
```

Look for `✔ Container four-nations-bridge  Started`.

> If you see `invalid spec: … too many colons`, your `bridge.env` and
> `docker-compose.yml` are from **before bridge 1.3.0** — download your setup
> files again from the app. Windows content paths need the newer pair (planning
> doc 119).

## 4. Finish in the setup page

Open `http://localhost:8124` in a browser **on this PC**. Three steps: paste
your pairing key, confirm your settings, done. When it shows **Connected**, the
bridge is indexing — close the window; it keeps running.

Sign in to your account from any device — phone, laptop, tablet — and your
content library is there. Pairing is account-level: there's nothing to set up
per device. A partner pairs with their **own** account; accounts are never
shared.

## Manual alternative (the WSL installer script)

The shell installer (`install-linux.sh`) is bash, so on Windows it needs a WSL
distro with Docker Desktop's WSL integration enabled, and it takes content paths
in WSL form (`/mnt/c/Users/you/Content`). It is **not** the recommended path —
the wizard above needs no Linux distro at all — but it is available if you
already live in WSL. See [linux.md](linux.md); everything there applies once
you're inside the distro's terminal.

To verify the image signature yourself before running anything, see
[security.md](security.md).

## Everyday operations

Run these in PowerShell, from your `four-nations-bridge` folder.

| Task | How |
| --- | --- |
| Check the bridge | open `http://localhost:8124` (status page) |
| Logs | `docker logs four-nations-bridge` |
| Stop / start | `docker compose stop` / `docker compose start` |
| Update to a new release | edit the image tag in `docker-compose.yml`, then `docker compose --env-file bridge.env up -d` (pairing survives — it lives in `bridge-data`, not the image) |
| Change your content folder | edit `CONTENT_BRIDGE_HOST_CONTENT_PATH` **and** `CONTENT_BRIDGE_CONTAINER_MOUNT_PATH` in `bridge.env` together, then recreate. Easier: re-download the files from the wizard with the new folder. |
| Re-pair | see [security.md → Re-pairing](security.md#re-pairing) |
