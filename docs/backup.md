# Backup media modes

Local encrypted backups work out of the box; no S3 account or endpoint is required.
For small public servers with limited disk, use:

```toml
[backup]
enabled = true
interval_secs = "1d"
keep = 1
media_mode = "profile_assets"

[backup.remote]
enabled = false
```

`none` includes the database and locally stored cold message history. `profile_assets`
also includes locally stored avatars, banners, guild icons, custom emoji and stickers,
selected through database references rather than upload categories. `all` includes
all local media, including attachments and videos. Remote caches (`cache/`, `camo/`)
are never included. Data held in external object stores requires its own backup;
the archive reports these exclusions.

The code default remains `all` so upgrading does not silently reduce coverage.
Existing `include_media = true` and `false` settings map to `all` and `none` with a
deprecation warning. Replace the old key with `media_mode`; do not specify both.

Restore uses the same encrypted archive format for every mode. A profile-assets
backup restores the database references and included files; omitted attachments
remain unavailable. Use a fresh destination for recovery. With `--yes`, an included
media tree replaces the old tree (which is moved aside); a backup with no media
part leaves an existing media directory alone. Older archives remain readable.

The engine temporarily writes a database snapshot, compressed payload and encrypted
archive locally before uploading, so allow scratch space in addition to retained
archives. `backup.min_free_bytes` can reserve free space during backup creation.
Keep the encryption key somewhere recoverable independently of the server.

## Optional offsite recovery

Local backups cannot survive loss of the VPS or its disk. If you want offsite
copies, configure an S3-compatible endpoint, bucket and credentials, set
`backup.remote.enabled = true`, and use `backup.remote.keep = 2` (or more).
Local and remote retention are independent. Keeping only one remote backup can
replace the last healthy recovery point with a backup of a corrupt database.
Two copies reduce that risk but do not replace restore drills or longer retention.
