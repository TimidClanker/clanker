---
name: cloudflare-quick-tunnel
description: Expose a local HTTP service through a temporary public HTTPS URL using Cloudflare Quick Tunnels (trycloudflare.com). Use for sharing previews, demos, and receiving webhooks from inside the container.
---

# Cloudflare Quick Tunnels

`cloudflared` is installed in this container. Quick Tunnels need no Cloudflare account, token, domain, or login. They provide a random `https://….trycloudflare.com` URL for the lifetime of the tunnel process.

## Start a tunnel

1. Identify the intended app and port. Start its server if needed and verify a representative route locally, for example `curl -fsS --max-time 10 http://127.0.0.1:3000/`.
2. Use an origin reachable from this container. For an app in the same container, loopback works and no Docker port publishing is needed. For another container, use its service name and internal port on a shared Docker network; `localhost` would refer to this container. The other service must listen on an interface reachable from that network.
3. Start `cloudflared` as a background process that survives the shell tool returning. For example, replace port 3000 with the actual app port:

   ```bash
   tunnel_dir=$(mktemp -d /tmp/cloudflare-quick-tunnel.XXXXXX)
   nohup cloudflared tunnel --url http://127.0.0.1:3000 --output json \
     > "$tunnel_dir/tunnel.log" 2>&1 < /dev/null &
   tunnel_pid=$!
   printf '%s\n' "$tunnel_pid" > "$tunnel_dir/tunnel.pid"
   printf 'Tunnel PID: %s\nLogs: %s/tunnel.log\n' "$tunnel_pid" "$tunnel_dir"
   ```

4. Read the log for the generated HTTPS URL and connection registration. JSON output is a stream of log records with fields such as `level`, `message`, and `time`; the URL appears in message text. Do not assume a top-level `url` field.
5. Request the public URL with a bounded timeout and verify the expected app response before sharing it. Allow a short startup delay; if it remains unreachable after about 10 seconds, inspect the logs and origin instead of creating more tunnels.

Keep the app and tunnel running while the preview is needed. Record the origin, public URL, PID, and log path in the task so later work can reuse or stop this specific tunnel. Return the clickable URL and explain that it expires when the process or container stops; restarting creates a new URL.

## Scope and troubleshooting

- A Quick Tunnel makes the selected service publicly reachable. Expose only the app intended for sharing, not a directory containing credentials or an unrelated internal admin service. HTTPS does not add application authentication.
- A `502` usually calls for checking the origin address, port, and whether the app is still running. If the dev server rejects the public Host header, allow the exact generated hostname in its configuration.
- If logs show QUIC connectivity failures, stop that tunnel and retry with `--protocol http2` added to the command. Cloudflare connectivity still requires outbound access on port 7844.
- Quick Tunnels are for temporary development use, have a limit of 200 concurrent requests, and do not support Server-Sent Events.
- When finished, stop only the recorded tunnel process after confirming its identity. Avoid `pkill cloudflared`, which could interrupt another task. Stop the app only if this task started it and it is no longer needed.

References: [Quick Tunnels](https://try.cloudflare.com/), [Cloudflare setup and limitations](https://developers.cloudflare.com/tunnel/get-started/#quick-tunnels-development).
