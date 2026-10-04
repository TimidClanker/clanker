# Sandbox desktop

Build from the repository root:

```sh
docker buildx build --platform linux/amd64 --load -f Dockerfile.sandbox -t clanker-sandbox:dev .
```

The image includes headed Chromium, Playwright, Xvfb, Openbox, x11vnc, noVNC, xterm, and xdotool. Chromium and its matching Playwright version are installed at build time; starting a desktop needs no downloads.

## Bot integration

The sandbox extension defaults to `vcr.vercel.com/timid-clanker/sandboxes/clanker-sandbox:latest`; `SANDBOX_IMAGE` can override it. Existing persistent workspaces keep their saved filesystem when resumed, so changing the image only affects new workspaces.

Private identity workspaces retain snapshots for 365 days after last use; shared conversation workspaces retain them for 90 days. Only the latest snapshot is kept. The policy is applied to new sandboxes and updated on existing sandboxes when next used. Vercel manages snapshot expiration and eventual cleanup of inactive sandboxes that can no longer resume.

If you delete a sandbox in Vercel, the next sandbox tool call recreates it with the same workspace name and the currently configured image. It starts empty, including a fresh browser profile. A confirmed `snapshot_not_found` error retires the unusable sandbox and tells the agent this is terminal: its next sandbox tool call creates a fresh workspace, and it must rebuild any needed setup. Authentication, network, and other errors remain errors without replacing the workspace.

The agent uses `sandbox_desktop` to start/reconnect (`view`), hand control to a user (`control`), or close the desktop (`stop`). The tool loads the [browser skill](../../src/extensions/sandbox/skills/browser/SKILL.md), and `view_image` lets the agent inspect screenshots. The existing shell and file tools remain available. All tools use the same verified identity/group ownership checks.

The desktop runs separately from individual shell commands. Desktop credentials and command identity are stored inside the sandbox's private runtime directory so a bot restart can reconnect. After a sandbox resume, a new desktop gets fresh passwords. The usual five-minute sandbox idle timeout still applies; viewer activity alone does not extend it.

## Start on Vercel

Create the sandbox with the published image and `ports: [6080]`. Vercel does not run the image's `CMD`, so start the desktop explicitly:

```ts
import { randomBytes } from 'node:crypto'

const viewPassword = randomBytes(6).toString('base64')
const controlPassword = randomBytes(6).toString('base64')
const desktop = await sandbox.runCommand({
  cmd: 'sandbox-desktop',
  args: ['https://example.com'], // Optional; otherwise restore the existing browser profile.
  env: {
    DESKTOP_VIEW_PASSWORD: viewPassword,
    DESKTOP_CONTROL_PASSWORD: controlPassword
  },
  detached: true,
  timeoutMs: 30 * 60_000
})

const base = `${sandbox.domain(6080)}/vnc.html?autoconnect=true&resize=scale`
const viewer = `${base}&view_only=true#password=${encodeURIComponent(viewPassword)}`
// Only share this link when handing control to the user:
const controller = `${base}&view_only=false#password=${encodeURIComponent(controlPassword)}`

// Stop the desktop while keeping the sandbox running:
await desktop.kill('SIGTERM')
```

The default link lets users watch the agent work. The control link permits mouse and keyboard input when the agent asks for help. x11vnc enforces permissions based on the password: removing `view_only=true` cannot turn a viewer into a controller. The agent can continue using Playwright or xdotool inside the sandbox in either case.

Passwords must be distinct and exactly eight characters using letters, digits, `+`, or `/`. This matches VNC's eight-byte limit and keeps the password-file format unambiguous. URL fragments authenticate automatically without sending the password in HTTP request URLs. Treat both links as credentials; an issued control link remains valid for that desktop session. Restart with fresh passwords to revoke it.

The desktop lasts until its command or sandbox stops; set both timeouts to suit the session. A resumed sandbox needs the launcher run again.

## Run locally

Set `DESKTOP_VIEW_PASSWORD` and `DESKTOP_CONTROL_PASSWORD` in your shell, then:

```sh
docker run --rm --init -p 127.0.0.1:6080:6080 \
  -e DESKTOP_VIEW_PASSWORD -e DESKTOP_CONTROL_PASSWORD clanker-sandbox:dev
```

Open `http://localhost:6080/vnc.html?autoconnect=true&resize=scale&view_only=true` and enter the view password. For interactive control, use `view_only=false` and the control password.

## Control and state

- Viewers and controllers see the same desktop. Only control-password connections can send input through noVNC.
- Browser automation can connect to CDP at `http://127.0.0.1:9222` from inside the sandbox. Playwright is installed in `/opt/clanker/desktop/node_modules/playwright`.
- `DISPLAY=:99` is available to tools such as xdotool. `DESKTOP_SIZE` defaults to `1440x900`.
- The browser profile and service logs live under `DESKTOP_DIR`, which defaults to `/vercel/desktop`. They survive desktop restarts; survival across sandbox stops depends on the sandbox's persistence setting.
- Only the viewer port is exposed. VNC and CDP bind to loopback. Passwords are not baked into the image or passed to Chromium; x11vnc removes the temporary password file after reading it.
- The launcher permits one desktop per sandbox. Tini forwards shutdown signals to the process group and reaps exited processes; closing Chromium also stops the desktop.
