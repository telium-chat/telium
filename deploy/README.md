# Staging deploy

`staging.telium.chat`, running on one box from the image CI builds at a
`server-v*` tag.

## The shape of it

```
push a server-v<version> tag
   └─ .github/workflows/release-server.yml
        builds the image, pushes ghcr.io/telium-chat/telium:server-v<version>
          (and :server-latest when this is the highest release)
        builds the native tarballs, cuts the GitHub release
        appends the release to deploy/releases.json and commits it back
                                        │
                        (GitHub's involvement ends here)
                                        │
   ┌────────────────────────────────────┘
   │  telium-update.timer, every 60s on the box
   └─ update.sh: pull; if the digest moved, reconcile the config files
                 that ship with the release, then `compose up -d server`
   │
   └─ the server itself, every 6h: read releases.json, work out how far
                 behind it is, and say so if the answer is "far"
```

Nothing is published from a push to `main`. A commit that is not released never
becomes an image, so what staging runs is always a release that a tag names.

The arrow only points one way. GitHub is never told this machine exists, holds
no key to it, and cannot reach it — the box asks the registry whether anything
changed and acts on the answer itself. A compromised Actions runner, a leaked
`GITHUB_TOKEN`, a malicious workflow in a fork: none of them get a shell here,
because there is no shell here to get.

What that does *not* buy: anyone who can merge to `main` can put code in the
container, and that is inherent to auto-deploy rather than a gap in it. The
container is where that is contained — non-root uid 10001, read-only rootfs,
all capabilities dropped, no new privileges, and no Docker socket, ever. A
mounted `docker.sock` would undo every other line in this file.

## The tunnel

The public IP is firewalled, so Cloudflare Tunnel is the only ingress.
cloudflared runs as a **container on the app's own private network**, not as a
host service, and that is a deliberate choice rather than a stylistic one.

A tunnel token is remotely configured: whoever controls the Cloudflare account
decides which hostname maps to which address, and cloudflared complies. Run as
`cloudflared service install` on the host, that account can therefore reach
`127.0.0.1:22`, and every other loopback-published port on the box. Run as a
container on `172.31.240.0/28`, with `netguard.sh` closing the two routes Docker
leaves open (the host itself, and the LAN behind it), the same account can reach
`172.31.240.3:8448` and the public internet. That is the whole list.

So the tunnel staying up is also independent of the app staying up: a bad deploy
gives you a 502 you can read, not a hostname that stopped resolving.

## The SFU

`telium.toml` points calls at `sfu.telium.chat`, which is a different box with
its own public address and is deliberately **not** behind the tunnel: a tunnel
carries HTTP(S), an SFU is a UDP mixer, and a media host reached through one
would connect and then carry no sound. Its record in Cloudflare is DNS-only for
that reason; `staging.telium.chat` stays proxied.

This box's only part in a call is the join token it signs, which the client
spends at `https://sfu.telium.chat/session` — an HTTPS request, and the one part
of this the tunnel is fine for. Media never touches us.

The SFU must be told to trust this server in return, and that half cannot be set
from here: either a `[[trust.origins]]` entry in its own config naming
`staging.telium.chat` with `discovery_url = "https://staging.telium.chat"`, so
it fetches and re-verifies our key from `/_telium/v1/keys`, or `trust.public`,
which trusts any origin that publishes one. Without one of those it answers
every `/session` with a 403 and calls fail where they used to fall back to a
mesh — the first thing to check if voice breaks the day this region is added.

## Files

| on the box | from here | what it is |
| --- | --- | --- |
| `/opt/telium/compose.yml` | `compose.yml` | the two services and the network |
| `/opt/telium/telium.toml` | `telium.toml` | server config, mounted read-only |
| `/opt/telium/update.sh` | `update.sh` | the deploy, all of it |
| `/opt/telium/update.conf` | `update.conf` | whether, when and to what this box updates |
| `/opt/telium/telium.example.toml` | `server/telium.example.toml` | the reference config, refreshed by each release |
| `/opt/telium/.baseline/` | — | what the last release shipped, for the three-way compare below |
| `/opt/telium/netguard.sh` | `netguard.sh` | the firewall rules |
| `/opt/telium/tunnel.env` | — | `TUNNEL_TOKEN=…`, mode 600, never committed |
| `/srv/telium-backups/` | — | the archives and the backup key, outside the data volume on purpose |
| `/etc/systemd/system/telium-update.{service,timer}` | same names | the 60s poll |
| `/etc/systemd/system/telium-netguard.service` | same name | re-applies the fence when Docker restarts |

## Files not used by this box

- `telium-server.service`: the native systemd path. It runs `telium-server check` as `ExecStartPre`.
- `update-native.sh`, `telium-update-native.service`, `telium-update-native.timer`: the native path's updater, the container one's counterpart -- same arrow, same `update.conf` fields, manifest and sha256 instead of a registry digest, and a backup before every swap. Installed to `/usr/local/sbin` and `/etc/systemd/system` by hand; `docs/updates.md` has the commands.
- `reverse-proxy/nginx.conf`, `reverse-proxy/Caddyfile`: TLS in front, server on loopback ([production.md](../docs/production.md#the-reverse-proxy)).

## Installing

```sh
sudo ./install.sh [domain]
```

The optional domain is written into a freshly seeded `telium.toml` -- the
seeded file is this staging box's config, and its `server_name` and
`public_base_url` are the two lines that cannot stay. An existing
`telium.toml` is never touched, with or without the argument.

The native (no Docker) counterpart is `install-native.sh`, which takes the
domain the same way: `sudo ./install-native.sh chat.example.com` downloads
the release binary, creates the `telium` user, writes `/etc/telium/telium.toml`
from that domain, installs the unit and the native update timer, and starts
the server.

That is the whole thing. It puts the files in `/opt/telium`, creates
`/srv/telium-backups` owned by the container's uid, writes the systemd units
with this box's account substituted in, and **enables the timer**. Running it
again is how the machinery itself is upgraded: pull the repository, run it, and
the scripts and units are replaced while `compose.yml`, `telium.toml`,
`update.conf` and `tunnel.env` are left exactly as you have them.

The timer being enabled is the point of the script existing. A documented
sequence of nine commands has a line at the bottom that turns updates on, and
the line at the bottom is the one a reader skips — so "updates are on by
default" was only ever true for people who read carefully on a good day. Here it
is not a step that can be missed. Turning it *off* is a named field in
`update.conf` and takes one word.

Two credentials cannot come from a repository and are still yours to place; the
script prints both if they are missing.

```sh
# The tunnel token. Never goes in git, never goes in compose.yml.
printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" > /opt/telium/tunnel.env
chmod 600 /opt/telium/tunnel.env

# The registry credential. read:packages only -- it pulls and can do nothing
# else. Piped, so it is never a shell argument and never in any history.
op read 'op://Hurricane/<item>/credential' \
  | docker login ghcr.io -u 67plays --password-stdin
```

`docker login` writes to `~/.docker/config.json` for the account that ran it,
which is why `telium-update.service` runs as that user with `HOME` set — a root
unit would not find the credential and every pull would fail as
unauthenticated. `install.sh` takes that account from `sudo`, or from
`TELIUM_RUN_AS` if you need to say.

## How this box updates

`/opt/telium/update.conf` is the answer, in fields with names:

```sh
TELIUM_UPDATES=automatic   # or `manual`: check, report, and wait for you
TELIUM_PIN=                # or sha256:… to hold this box at one image
TELIUM_PIN_REASON=         # required whenever TELIUM_PIN is set
TELIUM_UPDATE_WINDOW=      # or HH:MM-HH:MM, restarts only inside it
TELIUM_MANAGE_COMPOSE=yes  # may a release update compose.yml
```

```sh
/opt/telium/update.sh --status   # what this box currently thinks
/opt/telium/update.sh --now      # take a waiting release immediately
```

A release whose annotated tag carried `Breaking-change: yes` is downloaded but
not deployed until you run `--now`. `Upgrade-notes:` are printed to the journal
before any restart. Both come from labels on the image.

### Moving a box off the old `:main` channel

The server used to publish every commit to the `:main` image tag. It no longer
does, and that tag will not move again — so a box still pointed at it will hold
its current image forever and will never pick up a release. This is the one
change `update.sh` cannot make for itself: it reconciles `compose.yml` only
after it has pulled an image that moved, and a frozen tag never moves.

Edit the image line once, by hand, and the timer takes it from there:

```sh
# /opt/telium/compose.yml
-    image: ghcr.io/telium-chat/telium:main
+    image: ghcr.io/telium-chat/telium:server-latest
```

Then let the timer run, or `docker compose -f /opt/telium/compose.yml pull server`
and restart. A box installed fresh from `deploy/install.sh` gets `server-latest`
already and needs none of this.

Expect one piece of noise on the next release after you edit it. `update.sh`
keeps a baseline of what the last release shipped and compares three files —
shipped, baseline, and yours — and your edit now differs from that baseline, so
it cannot tell your change from drift. It will leave your file alone, write the
new one as `compose.yml.dist`, and tell you to merge it. The two files are
already identical in the one line that matters, so the merge is
`/opt/telium/update.sh --config-resolved`. It does not recur: that command
records the new baseline.

If you would rather not touch the file, `TELIUM_PIN=ghcr.io/telium-chat/telium:server-latest`
also works — a pin is an override, so the first release after it applies the
shipped `compose.yml` for you and clears the condition. It is a pin, though, and
a pin without a `TELIUM_PIN_REASON` is reported as an error on every run.

A pin is written as a Compose override file, so `compose.yml` is never edited
and clearing one line follows the channel again. `TELIUM_PIN` takes an image tag
(`ghcr.io/telium-chat/telium:server-v0.2.0`) or a digest.
`TELIUM_PIN_REASON` is not bureaucracy: the pin will outlive your memory of it
and may outlive your involvement with this machine, and a pin with no reason on
file is why old servers stay old. It is honoured without one — overriding an
explicit choice because a field was left blank is not this script's call — and
it is reported as an error on every run until you write one.

The server has a matching half that is not about this box at all: it knows which
commit it was built from, reads `deploy/releases.json` every few hours, and gets
progressively harder to ignore the longer it has been behind. What that check
transmits, and how to turn it off, is in
[the operator guide](../docs/operator-guide.md#staying-current).

## Configuration that ships with a release

A release can change `compose.yml` — a new volume, a tightened security option,
a port that moved. `update.sh` used to be unable to deliver that: only the image
was pulled, so half of what a release said was silently dropped, and a deploy
that cannot deliver half a release is not an automatic update.

Copying the new file over the old one would be the obvious fix and is wrong:
`/opt/telium/compose.yml` is also *your* file. So a third copy is kept in
`/opt/telium/.baseline/`, holding what the last release shipped, and the
comparison between the three answers the question cleanly:

| shipped vs baseline | your copy vs baseline | what happens |
| --- | --- | --- |
| same | anything | nothing, silently — the release did not touch it |
| changed | same | applied, and the log says what moved |
| changed | changed | **nothing is overwritten** |

The last row writes the new file beside yours as `compose.yml.dist` and warns on
every single run until you merge it and say so:

```sh
diff /opt/telium/compose.yml /opt/telium/compose.yml.dist
# merge by hand, then:
/opt/telium/update.sh --config-resolved
```

The image is deployed in all three cases, including the conflict. Gating a
security fix on an unmerged config hunk would hold the fix hostage to paperwork,
and the merge is usually three lines. What it must not do is go quiet, so it
does not — the warning repeats forever, which is the correct amount of noise for
a thing that is genuinely still wrong.

`telium.toml` is **never** written by this script under any circumstances. Every
key the server reads has a default compiled in, so a release cannot break your
config by adding to it. What arrives instead is `telium.example.toml`, refreshed
next to it, to `diff` when you feel like it.

`TELIUM_MANAGE_COMPOSE=no` turns the reconciliation off entirely. You will still
be told what changed, and the box may then be running against infrastructure
that no longer matches it.

## Checking on it

```sh
systemctl list-timers telium-update.timer     # when it last ran, when it next will
journalctl -u telium-update.service -n 50     # what each deploy did, if anything
/opt/telium/update.sh --status                # mode, pin, window, pending conflict
docker compose -f /opt/telium/compose.yml ps
docker compose -f /opt/telium/compose.yml logs -f server
sudo iptables -S DOCKER-USER                  # the fence, as it currently stands
```

`update.sh` is silent when nothing moved, so an empty journal is the healthy
state; a deploy logs the digest it went from and to.

## Backups

The one thing to know: **the archives are not in the data volume**, and until
2026-09-18 they were. On that day the deployment was re-provisioned,
`telium_telium-data` was created empty at 00:08:32, and everything the server
had held went with the volume it replaced. `[backup]` pointed `dir` and
`key_file` inside that volume and carried a comment saying what that would
mean, so nothing about the outcome was a surprise. It was a prediction, in
writing, in the file, that nobody happened to be reading on the morning it came
true — which is the argument for the server saying it out loud at every start
rather than the config saying it once in a comment.

There were, as it turned out, no archives in that directory to lose: the
scheduler deferred its first run by a full interval, so the directory had never
been created at all. Two independent bugs arriving at the same nothing. Both are
fixed below; the first one is the one that would have mattered.

### Where it goes

| | path | survives |
| --- | --- | --- |
| data | `telium-data` volume → `/var/lib/telium` | — |
| archives | `/srv/telium-backups` → `/var/backups/telium` | `docker volume rm`, `compose down -v`, a re-provision |
| off-box | `[backup.remote]`, an S3-compatible bucket | the disk, the box, the building |

The middle row is what this box has now. It is a floor, not an answer: a bind
mount on the same disk survives every way the *data* is lost and none of the
ways the *machine* is. The bottom row is the answer and it is off, because it
needs credentials, and credentials are not a thing this repository can hold.

### What is in an archive

One run writes one file, `/srv/telium-backups/archives/telium-<unix-ms>.tbk`,
sealed under AES-256-GCM with the key at `/srv/telium-backups/backup.key`:

- the **whole SQLite database** — accounts, messages, guilds, memberships, and
  the database-resident secrets: federation signing keys and the Web Push key;
- the **cold archive** (`/var/lib/telium/cold`), archived history segments;
- the **media store** (`/var/lib/telium/media`) minus `cache/` and `camo/`,
  which hold other servers' bytes and are re-fetched on demand.

Explicitly **not** covered, by this or anything else on this box:

- `backup.key` itself. An archive without it is noise, and it sits on the same
  machine as the archives. **Copy it into a password manager today.** The
  server logs an `ERROR` in capitals the first time it mints one; that line is
  the whole of the reminder and it goes past in the startup log exactly once.
- `/opt/telium/tunnel.env`, the Cloudflare tunnel token.
- `compose.yml`, `telium.toml`, `update.sh`, `netguard.sh` and the systemd
  units — they are in this repository, which is their backup, and an install
  from here plus a restore is the whole of a rebuild.
- The registry credential in `~/.docker/config.json`.
- The Cloudflare account itself: DNS, the tunnel, the hostname. Losing that is
  not a data-loss problem and this does not help with it.
- Anything under `/tmp` in the container, which is a tmpfs and is meant to go.

### The SQLite part, which is where naive backups go wrong

Copying `telium.db` out of a running server is not a backup of anything in
particular. The database runs in WAL mode: committed transactions sit in
`telium.db-wal` until a checkpoint folds them in, so the `.db` alone is missing
recent writes, and `cp`ing the `.db`, `-wal` and `-shm` as three separate reads
gives three different instants of a file that is moving between them. That
restores, and opens, and is wrong — which is the bad kind of wrong, because
nothing announces it until something downstream trips over it weeks later.

The server does not do that. Every run issues `VACUUM INTO`, which asks SQLite
for one consistent snapshot written as one new file while the server keeps
serving, and the `-wal`/`-shm` files are not in the archive at all because the
snapshot has already absorbed them. `docker cp` of the volume, or an `rsync` of
`/var/lib/telium`, is the naive version; it is not a substitute for this and
should not be used as one.

### The schedule

Every six hours (`interval_secs = 21600`), and **the first one is taken at
startup** when there is no archive newer than the interval. That clause is new.
The scheduler used to wait one full interval after boot, always, which meant a
freshly provisioned box held nothing for six hours and a box redeployed more
often than that never reached its first tick at all. The empty backup directory
found on the old staging box was that, not a crash: the code was correct,
scheduled, and had simply never run once.

### Checking on it

```sh
docker compose -f /opt/telium/compose.yml exec server telium-server backup list
ls -l /srv/telium-backups/archives
docker compose -f /opt/telium/compose.yml logs server | grep -i backup
```

The admin pane in the client reads `GET /_telium/v1/admin/status` and shows the
same thing without a shell: `placement` (`inside` / `same-device` / `separate`
— where the archives sit relative to the data), `offsite`, `stale`,
`key_stranded`, and the last error from either half.

The startup lines are the ones to read. The server states where the archives go
relative to the data, at `ERROR` if the only copy is inside the data it is a
copy of, and at `ERROR` again — every interval, not once — if the newest
archive is older than `stale_after_secs`, or if no archive has ever been
written.

### Restoring

The server must be stopped, and the key must be the one the archive was sealed
under.

```sh
docker compose -f /opt/telium/compose.yml stop server

# `latest` is the newest archive in backup.dir. A path or `s3://latest` also
# work. The entrypoint already carries --config; --no-deps keeps this from
# bringing the tunnel along for the ride.
docker compose -f /opt/telium/compose.yml run --rm --no-deps \
  server restore latest --yes

docker compose -f /opt/telium/compose.yml start server
```

It decrypts and authenticates every byte into a staging directory beside the
database before touching anything, refuses an archive taken at a newer schema
version than the binary, and moves the existing database, media and cold store
aside as `<name>.pre-restore-<stamp>` rather than deleting them. Remove those
by hand once the restored server checks out.

Onto a **fresh box**: install as above, put the saved `backup.key` at
`/srv/telium-backups/backup.key` *before the first start*, then restore, then
start. A server that starts without a key mints one, and a minted key does not
open archives sealed under the old one — those are still fine, but restoring
them then needs `--key <the original>` and a moment of working out which of two
keys is which, at the worst possible time. The restored database carries the
federation signing-key history, so do not mint a new server identity just
because the hardware is new. `docs/backup.md` is the long form.

### Restoring the restore

A restore nobody has run is a plan, not a capability, and the first real run of
one is always on a bad day. So it runs on good days instead:
`.github/workflows/backup-restore.yml` fires on every change under `server/` —
a real server, a real MinIO bucket, a row created through the API, the database
deleted, `restore s3://latest --yes`, and the row logged back in.
`server/tests/backup.rs` does the same round trip on disk, including the case
this page exists for: archive to the second mount, delete the data directory
outright, and rebuild the box from the archive that outlived it.

## Rolling back

There is no automatic rollback, by choice — a staging box that silently reverts
teaches you nothing. Do it by hand, pinning the digest you want:

```sh
# In /opt/telium/update.conf -- not by stopping the timer, which would also
# stop the box noticing the fix when it lands.
TELIUM_PIN=sha256:…
TELIUM_PIN_REASON=rolled back from <digest>, <what broke>, <where it is tracked>
```

```sh
/opt/telium/update.sh --now   # apply the pin without waiting for the timer
```

The pin becomes a Compose override; clearing those two lines and waiting a
minute puts the box back on the channel. The server itself keeps counting the
releases it is behind while pinned, and keeps saying so, which is what stops a
rollback taken on a bad afternoon from quietly becoming the permanent state of
the machine.

Images are pruned after a week, so a digest older than that has to come from the
registry again.

## First run

`registration.open` is `true` in `telium.toml` and **the first account created
on a fresh server becomes its admin**. The hostname is public the moment the
tunnel connects. Make your account, then set it to `false` and
`docker compose up -d server`.
