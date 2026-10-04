#!/usr/bin/env bash
set -euo pipefail

for name in DESKTOP_VIEW_PASSWORD DESKTOP_CONTROL_PASSWORD; do
    if [[ ! ${!name:-} =~ ^[A-Za-z0-9+/]{8}$ ]]; then
        echo "$name must contain exactly 8 characters: letters, digits, + or /." >&2
        exit 1
    fi
done
if [[ $DESKTOP_VIEW_PASSWORD == "$DESKTOP_CONTROL_PASSWORD" ]]; then
    echo 'View and control passwords must be different.' >&2
    exit 1
fi
if [[ -z ${DBUS_SESSION_BUS_ADDRESS:-} ]]; then
    exec tini -s -g -- dbus-run-session -- "$0" "$@"
fi

export DISPLAY=${DISPLAY:-:99}
export DESKTOP_DIR=${DESKTOP_DIR:-/vercel/desktop}
export DESKTOP_SIZE=${DESKTOP_SIZE:-1440x900}
export XDG_RUNTIME_DIR=/tmp/clanker-desktop-runtime
umask 077
mkdir -p "$XDG_RUNTIME_DIR" "$DESKTOP_DIR/logs"
chmod 700 "$XDG_RUNTIME_DIR"
exec 9>"$XDG_RUNTIME_DIR/desktop.lock"
flock -n 9 || { echo 'A sandbox desktop is already running.' >&2; exit 1; }

printf '%s\n' "$DESKTOP_CONTROL_PASSWORD" '__BEGIN_VIEWONLY__' "$DESKTOP_VIEW_PASSWORD" >"$XDG_RUNTIME_DIR/vnc-passwords"
unset DESKTOP_VIEW_PASSWORD DESKTOP_CONTROL_PASSWORD
trap 'kill $(jobs -pr) 2>/dev/null || true; wait || true' EXIT
trap 'exit 0' INT TERM

Xvfb "$DISPLAY" -screen 0 "${DESKTOP_SIZE}x24" -nolisten tcp >"$DESKTOP_DIR/logs/display.log" 2>&1 &
for attempt in {1..100}; do
    xdpyinfo >/dev/null 2>&1 && break
    sleep 0.1
done
xdpyinfo >/dev/null

openbox >"$DESKTOP_DIR/logs/window-manager.log" 2>&1 &
x11vnc -display "$DISPLAY" -localhost -rfbport 5900 -passwdfile "rm:$XDG_RUNTIME_DIR/vnc-passwords" \
    -forever -shared -xkb >"$DESKTOP_DIR/logs/vnc.log" 2>&1 &
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >"$DESKTOP_DIR/logs/viewer.log" 2>&1 &
bun /opt/clanker/desktop/browser.mjs "$@" >"$DESKTOP_DIR/logs/browser.log" 2>&1 &

wait -n
