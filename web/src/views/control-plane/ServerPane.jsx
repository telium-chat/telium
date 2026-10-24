import { Hint, Notice, Pill, Section } from '../../components/index.js';
import { Facts, Fact, Freshness } from './Bits.jsx';
import { useControlPlane } from './context.js';
import { useLive } from './useLive.js';
import { ABSENT, count, duration, present, size } from './format.js';

const yes = (v) => (v === true ? 'on' : (v === false ? 'off' : ABSENT));

function Restart() {
  return <Pill tone="warn">needs a restart</Pill>;
}

export function ServerPane() {
  const { home, metrics, status } = useControlPlane();

  const caps = useLive(() => home.capabilities(), { interval: 300_000 });
  const store = useLive(() => home.adminStorage(), { interval: 300_000 });

  const c = caps.data || {};
  const m = metrics.data || {};
  const s = store.data || {};
  const media = c.media || {};
  const features = c.features || {};
  const roles = c.roles || {};

  return (
    <>
      <Section
        title="This server"
        actions={<Freshness at={caps.at} error={caps.error} interval={300_000} />}
      >
        <Facts>
          <Fact name="Server name" value={c.server_name || status.data?.server_name} mono />
          <Fact name="Version" value={c.server_version} mono />
          <Fact name="Protocol" value={c.protocol} mono />
          <Fact
            name="Uptime"
            value={present(m.uptime_ms) ? duration(m.uptime_ms) : ABSENT}
            why="How long this process has been up, which is also the window every counter on
              the overview pane covers."
          />
          <Fact
            name="Roles"
            value={[roles.identity && 'identity', roles.guild && 'guild', roles.media && 'media']
              .filter(Boolean).join(', ') || ABSENT}
            why="A disabled role does not mount its routes at all, so a client learns it is
              unavailable from the capabilities document rather than from a 404."
          />
          <Fact name="Abuse contact" value={media.abuse_contact} mono />
        </Facts>
      </Section>

      <Section
        title="Changeable while the server runs"
        description="These are the operator decisions that take effect immediately, and every
          one of them is on another pane of this console."
      >
        <Facts>
          <Fact
            name="Defederation and blocklist feeds"
            value="Federation pane"
            why="Blocking or unblocking a domain applies to the next request. Feeds re-verify
              and re-apply on refresh."
          />
          <Fact
            name="Report outcomes"
            value="Moderation pane"
            why="Resolutions are written to the database, not to the configuration."
          />
          <Fact
            name="Storage sweeps and archive passes"
            value="Storage pane"
            why="Both are maintenance jobs the running process performs on demand."
          />
          <Fact
            name="Peer revalidation"
            value="Federation pane"
            why="Re-runs discovery and key fetch against cached peers."
          />
        </Facts>
      </Section>

      <Section title="Registration" actions={<Restart />}>
        <Facts>
          <Fact
            name="Open to new accounts"
            value={yes(c.registration_open)}
            why="This also goes false during a sunset window, which is a decision taken
              elsewhere rather than a setting."
          />
          <Fact name="Minimum password length" value={count(c.registration_min_password_len)} />
          <Fact
            name="Accepting recommendations"
            value={yes(c.onboarding?.recommendations?.accepting)}
            why="Whether other servers may send this one signups they cannot take themselves."
          />
          <Fact
            name="Suggesting alternatives"
            value={yes(c.onboarding?.recommendations?.suggest_alternatives)}
            why="Whether this server offers a would-be member somewhere else to sign up when it
              cannot take them."
          />
        </Facts>
      </Section>

      <Section title="Media policy" actions={<Restart />}>
        <Facts>
          <Fact
            name="Hosting media"
            value={yes(media.enabled)}
            why="With the media role off this server stores no files at all; the storage pane
              says so rather than showing zeroes."
          />
          <Fact
            name="Default policy"
            value={media.default_policy}
            why={'"disabled" still allows the small profile-asset carveout, so avatars work on a '
              + 'server that hosts nothing else.'}
          />
          <Fact
            name="Profile asset carveout"
            value={size(c.account?.profile_asset_carveout_bytes)}
          />
          <Fact
            name="Largest file"
            value={size(media.max_file_bytes)}
            why="Raising this raises the peak memory and disk a single upload can cost, and
              every peer caching it pays the same."
          />
          <Fact
            name="Longest expiry"
            value={media.max_expiry_secs ? duration(media.max_expiry_secs * 1000) : 'no cap'}
          />
          <Fact
            name="Upload scanning"
            value={present(media.hash_list_entries)
              ? `${count(media.hash_list_entries)} hash entries loaded`
              : ABSENT}
            why="The scanning hook is unconditional; the entry count is what says whether a list
              was ever actually loaded. Zero entries means the hook runs and matches nothing."
          />
          <Fact
            name="Remote cache cap"
            value={s.media_cache_max_bytes ? size(s.media_cache_max_bytes) : 'no cap'}
            why="The ceiling for cached copies of other servers' media. The sweep on the storage
              pane is what actually reclaims it."
          />
        </Facts>
      </Section>

      <Section title="Features in force" actions={<Restart />}>
        <Facts>
          <Fact name="Federation" value={yes(features.federation)} />
          <Fact name="Direct messages" value={yes(features.dms)} />
          <Fact name="Voice" value={yes(features.voice)} />
          <Fact name="Embed proxy" value={yes(features.embed_proxy)} />
          <Fact
            name="Rate limiting"
            value={yes(features.rate_limit)}
            why="In-process by design, because one authoritative guild has one process accepting
              its writes. It depends on trustworthy source attribution, which is why the
              trusted-proxy list matters."
          />
          <Fact
            name="Cold archive"
            value={yes(features.archive)}
            why={s.cold?.enabled
              ? `History older than ${s.cold.horizon_days} days is eligible for a cold segment.`
              : undefined}
          />
          <Fact name="GIF provider" value={yes(features.gif_picker)} />
          <Fact
            name="Call transports"
            value={[c.calls?.relay && 'relay', c.calls?.sfu && 'SFU'].filter(Boolean).join(', ')
              || 'mesh only'}
            why="A client reads this before it joins, so a relay-only posture on a home with no
              TURN asks for an SFU instead of dialling a mesh it would have to refuse."
          />
        </Facts>
      </Section>

      <Section title="Measurement" actions={<Restart />}>
        {m.enabled === false ? (
          <Notice tone="warn">
            {'[metrics] enabled = false. Counters are not being collected and no history is '
             + 'being written. Nothing else on this server is affected.'}
          </Notice>
        ) : null}
        <Facts>
          <Fact name="Collecting" value={yes(m.enabled)} />
          <Fact
            name="Rollup interval"
            value={present(m.interval_secs) ? duration(m.interval_secs * 1000) : ABSENT}
            why="One row per interval. A shorter interval buys resolution and costs rows;
              nothing here is ever written per request."
          />
          <Fact
            name="History kept"
            value={present(m.retention_days) ? `${m.retention_days} days` : ABSENT}
            why="Rows older than this are deleted as each new bucket is written, so the
              statistics pane cannot show a range longer than this no matter what is asked for."
          />
          <Fact
            name="Database pool"
            value={present(m.pool?.max) ? `${count(m.pool.max)} connections` : ABSENT}
            why="When every connection is checked out and none is idle, requests queue for the
              database rather than for the network. The overview pane says so when it happens."
          />
        </Facts>
      </Section>

      <Section title="Changing any of the above">
        <Hint>
          Every value in the restart-marked blocks comes from `telium.toml`, which this process
          read once at startup. There is no endpoint that edits it: a server that could rewrite
          its own configuration over the network is a server whose configuration is only as safe
          as the weakest admin session. Edit the file, keep a backup, and restart.
        </Hint>
        <Hint>
          `server/telium.example.toml` carries the annotated version of every key above, and the
          operator guide covers the decisions each one implies.
        </Hint>
      </Section>
    </>
  );
}
