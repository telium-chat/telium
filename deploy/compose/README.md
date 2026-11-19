# Compose kit

A Telium homeserver that is nothing but a Compose file:

    curl -fsSLO https://raw.githubusercontent.com/telium-chat/telium/main/deploy/compose/compose.yml
    printf 'TELIUM_DOMAIN=chat.example.com\nTELIUM_REGISTRATION=closed\n' > .env
    docker compose up -d

No installer, no host timer, no files beside it to keep in step. The guide
is https://docs.telium.chat/self-hosting/install-docker/.

| File | Role |
|---|---|
| `compose.yml` | The deployment: the server, the updater, and the optional `voice` (SFU) and `proxy` (Caddy) profiles. The server's `telium.toml` is the `TELIUM_CONFIG` block inside it. |
| `update.sh` | The updater's logic. Shipped inside the server image at `/usr/share/telium/deploy/compose/update.sh`; the `updater` service copies it out of the server container before every run. It is here for review and for the image build, not for running by hand. |

## How the updater works

The `updater` service is the stock `docker:cli` image with the Docker socket
and this directory (read-only, at `/project`) mounted. Every
`TELIUM_UPDATE_INTERVAL_SECS` (60) it:

1. copies the update logic out of the server container, so the logic is
   always the one the running release shipped;
2. pulls the image of every running service of the project except itself;
3. for whatever moved: holds a release labelled breaking until
   `telium-update --now`, waits for `TELIUM_UPDATE_WINDOW`, sends the restart
   notice (SIGUSR1 to the server and the SFU) and waits it out, then
   `docker compose up -d --no-deps <what moved>`.

It never recreates itself, so it never kills itself mid-update. A server
release from before the logic shipped in the image gets a minimal fallback
(pull the server, recreate it if it moved) until a release that carries the
logic arrives.

Because it re-reads `compose.yml` and `.env` to recreate services, settings
must live in `.env` (or in `compose.yml`), not only in the shell that ran
`docker compose up`.

## Testing

`deploy/tests/compose-kit-smoke.sh` boots the kit from `compose.yml` and a
`.env`, publishes a new server image to a throwaway local registry and checks
the updater replaces the server by itself. CI runs it on every change here.

## The older kits

`deploy/standalone/` (installer + host systemd timer) and `deploy/install.sh`
(the tunnel kit) are unchanged and keep working for boxes installed with them.
