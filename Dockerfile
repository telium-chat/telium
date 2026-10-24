# syntax=docker/dockerfile:1

# One binary and the client it serves, in an image that carries neither a
# compiler nor a package manager nor a shell account that can use them.
#
# The server can serve the built web client itself (`[web] dir`), which is the
# single-domain shape the README recommends, so the client is built here rather
# than deployed separately. Two build stages, one runtime stage, and nothing
# from the build stages survives into the last one except two paths.


# ---- the client -------------------------------------------------------------

FROM oven/bun:1.4.0 AS web

WORKDIR /src/web

# Manifest first: the dependency install is the slow half and it only has to
# happen again when the lockfile moves, not when a component does.
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile

# The client's build identity, and the reason it has to be passed in here
# rather than worked out.
#
# `web/vite.config.js` falls back to `git rev-parse` when TELIUM_BUILD_ID is
# unset, and inside this stage that fallback cannot succeed: `.git` is excluded
# from the build context on purpose (see the server stage below) and this image
# has no git anyway. So without these arguments every container ever shipped
# serves a client that calls itself `dev`, sitting next to a server that
# reports a correct forty-character commit -- which is worse than either
# answer on its own, because the two disagree and only one of them is lying.
#
# Same variables, same units, same values as the server stage: the client and
# the server in one image then report one identity, and a bug report from a
# container says something true about both halves.
ARG TELIUM_BUILD_COMMIT=""
ARG TELIUM_BUILD_TIME=""
ENV TELIUM_BUILD_ID=$TELIUM_BUILD_COMMIT \
    TELIUM_BUILD_TIME=$TELIUM_BUILD_TIME

COPY web/ ./
RUN bun run build


# ---- the server -------------------------------------------------------------

FROM rust:1-slim-bookworm AS server

WORKDIR /src

# `telium-protocol` is a path dependency of the server crate, so it is part of
# the server's source even though it sits beside it rather than under it.
COPY telium-protocol/ telium-protocol/
COPY server/ server/

# The build identity. There is no `.git` in the build context -- it is excluded
# on purpose, because a directory that changes on every commit would invalidate
# the source layer on every commit -- so `build.rs` cannot read the commit for
# itself here and CI hands it over instead. Left empty (a plain `docker build`
# by hand, say) the server reports an unidentified build and, by design, refuses
# to conclude from that that it is up to date: see `server/build.rs`.
ARG TELIUM_BUILD_COMMIT=""
ARG TELIUM_BUILD_COMMIT_TIME=""
ARG TELIUM_BUILD_TIME=""
ENV TELIUM_BUILD_COMMIT=$TELIUM_BUILD_COMMIT \
    TELIUM_BUILD_COMMIT_TIME=$TELIUM_BUILD_COMMIT_TIME \
    TELIUM_BUILD_TIME=$TELIUM_BUILD_TIME

# The target directory and the crate registry are cache mounts rather than
# image layers. A layer cache is keyed on the COPY above, so touching one file
# in `src/` would otherwise rebuild every dependency from source; a cache mount
# survives that, and survives across builds on a runner that keeps its state --
# which the self-hosted runner does. The binary is copied out because a cache
# mount is not part of the resulting layer.
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/server/target,sharing=locked \
    cargo build --release --locked --manifest-path server/Cargo.toml \
 && install -Dm755 server/target/release/telium-server /out/telium-server


# ---- what actually ships ----------------------------------------------------

FROM debian:bookworm-slim

# `curl` is here for the healthcheck and nothing else. TLS roots are compiled
# into the binary (rustls with webpki-roots, no OpenSSL anywhere in the tree),
# so `ca-certificates` is for curl's benefit rather than the server's.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --user-group \
      --home-dir /var/lib/telium --shell /usr/sbin/nologin telium

COPY --from=server /out/telium-server /usr/local/bin/telium-server
COPY --from=web    /src/web/dist      /srv/telium/web

# What a release wants the box's own files to look like. `update.sh` pulls these
# two out of the image with `docker cp` and reconciles them against what is
# installed in /opt/telium, which is how a change to the compose file reaches a
# running homeserver at all -- before this, only the image itself ever moved,
# and half of what a release changed silently stayed behind. Read-only
# reference copies: nothing in the container reads them, and the server's own
# config is still the one mounted at /etc/telium/telium.toml.
COPY deploy/compose.yml            /usr/share/telium/deploy/compose.yml
COPY server/telium.example.toml    /usr/share/telium/deploy/telium.example.toml

# The data: the SQLite database and its -wal/-shm siblings, uploaded media, the
# read-through caches for remote media and embeds, and cold archive segments.
RUN install -d -o telium -g telium /var/lib/telium

# The backups, and a separate path on purpose. An archive kept inside the data
# it is an archive of goes wherever the data goes -- which is the same mount,
# the same volume and the same `docker volume rm`. Mount something here that is
# not the data volume; the backup key goes here too, because archives that
# outlive the volume sealed under a key that did not are unreadable by anyone.
# Created owned by telium so a bind mount that is not pre-created still leaves
# the server able to write, and so the path exists at all when nothing is
# mounted over it.
RUN install -d -o telium -g telium -m 700 /var/backups/telium

USER telium
WORKDIR /var/lib/telium

# The only listener in the server: API, federation, the WebSocket gateway, the
# admin routes and the static client all share it.
EXPOSE 8448

# A real database round-trip, not a liveness ping that a wedged pool would pass.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8448/_telium/v1/health || exit 1

ENTRYPOINT ["telium-server", "--config", "/etc/telium/telium.toml"]
CMD ["serve"]
