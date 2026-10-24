<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/public/brand/telium-lockup-light.svg">
    <img alt="Telium" src="site/public/brand/telium-lockup-dark.svg" width="300">
  </picture>
</p>

Telium is a self-hosted chat app with guilds, channels, roles, threads, DMs, voice and video. Your account lives on your server. A guild lives on its own server, and you can join guilds hosted anywhere.

DMs are end-to-end encrypted with MLS. Guild channels are not, so the guild's server can read them.

<p align="center">
  <img alt="The Telium client" src="site/public/screenshots/client-dark.webp" width="900">
</p>

> [!WARNING]
> Telium is alpha. Expect breaking changes, and keep backups you have tested.

## Run it

You need Rust 1.85+ and Bun.

```sh
git clone https://github.com/telium-chat/telium.git
cd telium/server
cargo run -- init     # writes telium.toml
cargo run -- serve    # 127.0.0.1:8448
```

In a second terminal:

```sh
cd telium/web
bun install
bun run dev           # http://localhost:5173
```

Open the client and register. The first account on a fresh server becomes its admin.

## Host it

Build the client and let the server serve it:

```sh
cd web && bun run build
cd ../server && cargo run --release -- serve
```

```toml
server_name     = "chat.example.com"
public_base_url = "https://chat.example.com"

[web]
dir = "../web/dist"
```

Put TLS in front and proxy to `127.0.0.1:8448`. Other servers find yours through `https://<server_name>/.well-known/telium/server`, so federation needs a real domain and certificate. Pick `server_name` once, because every ID on the server includes it.

[`server/telium.example.toml`](server/telium.example.toml) lists every option with its default.

## Clients

The same React client runs in the browser, an Electron desktop app for Linux and Windows, and a Tauri app for Android.

## Develop

```sh
cd server && cargo test
cd web && bun run test    # bare `bun test` skips the Vitest config
```

## Contributing

Report bugs on the issue tracker, or in the client under Settings → Help & feedback. Report security issues privately through [SECURITY.md](SECURITY.md). [CONTRIBUTING.md](CONTRIBUTING.md) covers the rest.

[Apache 2.0](LICENSE)
