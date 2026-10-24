import { useEffect, useMemo, useState } from 'react';
import { normalizeRichActivity } from '../lib/activity.js';
import { embedFor } from '../lib/embeds.js';
import { mediaUrl } from '../lib/media.js';
import { activityKind } from '../lib/util.js';
import { useOptionalStore } from '../hooks/useStore.jsx';
import { ACTIVITY_ICONS } from './icons.jsx';
import { EmojiText } from './Twemoji.jsx';

function duration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function musicDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function clockLine(activity, now) {
  const start = activity.timestamps?.start;
  const end = activity.timestamps?.end;
  if (end && end > now) return `${duration(end - now)} remaining`;
  if (start && start <= now) return `${duration(now - start)} elapsed`;
  return null;
}

function musicProgress(activity, now) {
  if (activity.type !== 2) return null;
  const start = activity.timestamps?.start;
  const end = activity.timestamps?.end;
  if (!start || !end || end <= start) return null;
  const total = end - start;
  const elapsed = Math.min(total, Math.max(0, now - start));
  return {
    elapsed,
    total,
    percent: Math.round((elapsed / total) * 1000) / 10,
  };
}

function directArtworkUrl(raw, allowExternal = false) {
  if (typeof raw !== 'string' || !raw) return null;
  if (!allowExternal) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function camoArtworkUrl(raw, base) {
  if (typeof raw !== 'string' || !raw || !base) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    if (url.origin !== new URL(String(base)).origin) return null;
    if (!/\/_telium\/v1\/camo\/[0-9a-f]{64}\/?$/i.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function artworkProxyApis(store) {
  const seen = new Set();
  const apis = [];
  const add = (api) => {
    if (!api?.base || seen.has(api.base)) return;
    seen.add(api.base);
    apis.push(api);
  };

  if (store?.apis instanceof Map) {
    for (const api of store.apis.values()) add(api);
  }

  if (store?.guilds instanceof Map && typeof store.apiForGuild === 'function') {
    for (const [guildId] of store.guilds) add(store.apiForGuild(guildId));
  }

  add(store?.home);
  return apis;
}

function teliumArtworkUrl(media, proxyApis) {
  if (!media?.origin || !media?.hash || !media?.capability) return null;
  const ref = `${media.hash}?cap=${media.capability}`;

  const local = proxyApis.find((api) => api.domain === media.origin);
  if (local) return mediaUrl(local.base, ref);
  const proxy = proxyApis[0];
  return proxy ? mediaUrl(proxy.base, ref, media.origin) : null;
}

function useArtworkUrl(raw, media, proxyApis, proxyKey, allowDirectExternal) {
  const telium = teliumArtworkUrl(media, proxyApis);
  const direct = telium || directArtworkUrl(raw, allowDirectExternal);
  const sourceKey = [
    raw || '',
    media?.origin || '',
    media?.hash || '',
    media?.capability || '',
    proxyKey,
    allowDirectExternal ? 'direct' : 'proxied',
  ].join('\0');
  const [resolved, setResolved] = useState(() => ({ key: sourceKey, url: direct }));
  const current = resolved.key === sourceKey ? resolved.url : direct;

  useEffect(() => {
    if ((!raw && !telium) || direct) {
      setResolved({ key: sourceKey, url: direct });
      return undefined;
    }

    let alive = true;
    setResolved({ key: sourceKey, url: null });
    void (async () => {
      for (const api of proxyApis) {
        if (typeof api.embed !== 'function') continue;
        const preview = await embedFor(api, raw);
        const camo = camoArtworkUrl(preview?.image, api.base);
        if (!camo) continue;
        if (alive) setResolved({ key: sourceKey, url: camo });
        return;
      }
    })();
    return () => { alive = false; };
    // `proxyApis` is reallocated every progress tick; `sourceKey` stands in for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, direct, sourceKey]);

  return current;
}

function ActivityArtwork({ assets, name, kind, proxyApis, proxyKey, allowDirectExternal }) {
  const [largeFailed, setLargeFailed] = useState(false);
  const [smallFailed, setSmallFailed] = useState(false);
  const large = useArtworkUrl(
    assets?.large_image,
    assets?.large_media,
    proxyApis,
    proxyKey,
    allowDirectExternal,
  );
  const small = useArtworkUrl(
    assets?.small_image,
    null,
    proxyApis,
    proxyKey,
    allowDirectExternal,
  );

  useEffect(() => setLargeFailed(false), [large]);
  useEffect(() => setSmallFailed(false), [small]);

  const usableLarge = large && !largeFailed ? large : null;
  const usableSmall = small && !smallFailed ? small : null;
  const primary = usableLarge || usableSmall;
  const badge = usableLarge && usableSmall ? usableSmall : null;
  const Glyph = ACTIVITY_ICONS[kind] || ACTIVITY_ICONS.playing;

  return (
    <div className="activity-card__art">
      {primary ? (
        <img
          src={primary}
          alt=""
          title={usableLarge ? (assets?.large_text || name) : (assets?.small_text || name)}
          className="activity-card__cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => {
            if (usableLarge) setLargeFailed(true);
            else setSmallFailed(true);
          }}
        />
      ) : (
        <div className="activity-card__cover activity-card__cover--empty">
          <Glyph className="activity-card__cover-glyph" />
        </div>
      )}
      {badge ? (
        <img
          src={badge}
          alt=""
          title={assets?.small_text || undefined}
          className="activity-card__badge"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setSmallFailed(true)}
        />
      ) : null}
    </div>
  );
}

function ActivityTiming({ activity }) {
  const start = activity.timestamps?.start || 0;
  const end = activity.timestamps?.end || 0;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!start && !end) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [start, end]);

  const progress = musicProgress(activity, now);
  if (progress) {
    return (
      <div className="activity-card__progress">
        <span className="activity-card__time">{musicDuration(progress.elapsed)}</span>
        <div
          className="activity-card__track"
          role="progressbar"
          aria-label="Playback progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress.percent)}
        >
          <div className="activity-card__fill" style={{ width: `${progress.percent}%` }} />
        </div>
        <span className="activity-card__time">{musicDuration(progress.total)}</span>
      </div>
    );
  }

  const clock = clockLine(activity, now);
  return clock ? <div className="activity-card__clock">{clock}</div> : null;
}

export function RichActivityCard({ activity, className = '', allowDirectExternal = false }) {
  const store = useOptionalStore();
  const rich = useMemo(() => normalizeRichActivity(activity), [activity]);
  const proxyApis = artworkProxyApis(store);
  const proxyKey = proxyApis.map((api) => `${api.domain || ''}@${api.base}`).join('|');

  if (!rich) return null;
  const { kind, verb } = activityKind(rich.type);
  const Glyph = ACTIVITY_ICONS[kind] || ACTIVITY_ICONS.playing;
  const party = rich.party?.size ? `${rich.party.size[0]} of ${rich.party.size[1]}` : null;

  return (
    <div className={`activity-card ${className}`.trim()} data-kind={kind}>
      <ActivityArtwork
        assets={rich.assets}
        name={rich.name}
        kind={kind}
        proxyApis={proxyApis}
        proxyKey={proxyKey}
        allowDirectExternal={allowDirectExternal}
      />
      <div className="activity-card__text">
        <div className="activity-card__verb">
          <Glyph className="activity-card__verb-glyph" />
          {verb}
        </div>
        <div className="activity-card__name"><EmojiText>{rich.name}</EmojiText></div>
        {rich.details ? (
          <div className="activity-card__detail"><EmojiText>{rich.details}</EmojiText></div>
        ) : null}
        {rich.state ? (
          <div className="activity-card__state"><EmojiText>{rich.state}</EmojiText></div>
        ) : null}
        <ActivityTiming activity={rich} />
        {party ? <div className="activity-card__clock">{`${party} in party`}</div> : null}
        {rich.buttons.length ? (
          <div className="activity-card__buttons">
            {rich.buttons.map((button) => (
              <a
                key={`${button.label}:${button.url}`}
                href={button.url}
                target="_blank"
                rel="noreferrer"
                className="activity-card__button"
              >
                {button.label}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}


export function VoiceActivityCard({ activity, className = '' }) {
  if (!activity) return null;
  const Glyph = ACTIVITY_ICONS.voice;
  return (
    <div className={`activity-card ${className}`.trim()} data-kind="voice">
      <div className="activity-card__art" aria-hidden>
        <div className="activity-card__cover activity-card__cover--empty">
          <Glyph className="activity-card__cover-glyph" />
        </div>
      </div>
      <div className="activity-card__text">
        <div className="activity-card__verb">
          <Glyph className="activity-card__verb-glyph" />
          In Voice
        </div>
        <div className="activity-card__name"><EmojiText>{activity.channel_name}</EmojiText></div>
        <div className="activity-card__detail"><EmojiText>{activity.guild_name}</EmojiText></div>
      </div>
    </div>
  );
}
