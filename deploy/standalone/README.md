# Standalone Compose kit

The homeserver as one Compose project: a server container, an optional Caddy
front (`proxy` profile), an optional SFU (`voice` profile), updating itself on
a timer.

    sudo bash install.sh chat.example.com

It asks three questions -- who fronts the server, whether it carries voice,
and nothing else -- writes the answers into `.env`, and starts the stack.
Details and the manual (no-script) route are in the docs:
https://docs.telium.chat/self-hosting/install-docker/

This directory is the kit. `/opt/telium` on an installed box is a copy of it:
the operator's files (`.env`, `telium.toml`, `sfu.toml`, `Caddyfile`,
`update.conf`, and even `compose.yml`) are written once and never overwritten
by a re-run; the scripts and units are replaced, which is how the machinery
upgrades.

## Files

| File | Role |
|---|---|
| `compose.yml` | The three services and the fixed network that lets `trusted_proxies` name the front by address. |
| `.env` | Every answer in one place: domains, ACME mail, which profiles run, image pins. |
| `telium.toml` | The server's config; identity comes from `.env` via `${env:...}`. |
| `Caddyfile` | The kit's front, when the `proxy` profile is on. |
| `sfu.toml` | The SFU's config; no env support in this one, so domains are written in (the installer does it). |
| `install.sh` | The installer: asks, fetches, wires, starts, enables the timer. |
| `update.sh` + `telium-update.{service,timer}` | The updater; same `update.conf` fields as the tunnel kit. |
| `update.conf` | How the box updates: `automatic` (default), a pin, a maintenance window. |

## The two fixed addresses

The compose network is pinned to `172.31.241.0/28` so that two addresses can
be written down in configs:

- `172.31.241.2` — the kit's Caddy; the default `trusted_proxies` entry.
- `172.31.241.1` — the network gateway, which is the source address every
  host-side front arrives from; the swap for "I front it myself".

## Updating the kit's own files

The updater moves images only. A release that changes this directory says so
in its notes: pull the repository (or re-fetch the files) and re-run
`install.sh` — it replaces the scripts and units, leaves your files alone.
`docker compose run --rm server cat /usr/share/telium/deploy/standalone/...`
can diff the running release's reference copies against what you run.
