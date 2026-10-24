import { useCallback, useState } from 'react';
import {
  Button, Hint, Notice, Pill, SearchField, Section,
} from '../../components/index.js';
import { Fact, Facts, Pager, Tile, usePages } from './Bits.jsx';
import { DangerAction, Elevation } from './StepUp.jsx';
import { useControlPlane } from './context.js';
import { useLive } from './useLive.js';
import { ABSENT, clock, count, present, size } from './format.js';

const PAGE = 50;

export function GuildsPane() {
  const { home, stepUp } = useControlPlane();
  const [query, setQuery] = useState('');
  const [total, setTotal] = useState(null);

  const term = query.trim();
  const loadPage = useCallback(async (cursor) => {
    const r = await home.adminGuilds({
      limit: PAGE,
      ...(term ? { q: term } : {}),
      ...(cursor ? { cursor } : {}),
    });
    setTotal(present(r.total) ? r.total : null);
    return { items: r.guilds || [], cursor: r.next_cursor };
  }, [home, term]);
  const pages = usePages(loadPage, term);

  const loaded = pages.items;
  const moved = loaded.filter((g) => g.moved_to).length;
  const archived = loaded.reduce((n, g) => n + (g.archived_bytes || 0), 0);

  return (
    <>
      <Section
        title="Guilds"
        description="Every guild this server is the home for: its shape, its owner and what it
          costs to keep — and nothing that was said inside it."
        actions={(
          <>
            <Elevation stepUp={stepUp} />
            <Button size="sm" variant="ghost" onClick={pages.reload}>Refresh</Button>
          </>
        )}
      >
        <SearchField
          label="Search guilds"
          value={query}
          placeholder="Name or alias"
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
        />

        {loaded.length ? (
          <div className="cp-tiles">
            <Tile
              label="Matching"
              value={count(present(total) ? total : loaded.length)}
              note={present(total) && total > loaded.length
                ? `${count(loaded.length)} loaded`
                : 'all loaded'}
            />
            <Tile
              label="Moved away"
              value={count(moved)}
              note="history still here"
              tone={moved ? 'accent' : undefined}
            />
            <Tile
              label="In cold storage"
              value={size(archived)}
              note="across the loaded rows"
            />
          </div>
        ) : null}
      </Section>

      <Section title="Results">
        {pages.error ? (
          <Notice tone="danger">
            {pages.error?.body?.message || pages.error?.message || String(pages.error)}
          </Notice>
        ) : null}

        {pages.loading && !loaded.length ? <Hint>Reading the guild table.</Hint> : null}

        {!pages.loading && !loaded.length && !pages.error ? (
          <Notice>
            {term
              ? `No guild here is called anything like “${term}”.`
              : 'This server is not the home for any guild yet.'}
          </Notice>
        ) : null}

        <div className="cp-reports">
          {loaded.map((g) => (
            <GuildRow key={g.id} guild={g} onChanged={pages.reload} />
          ))}
        </div>

        <Pager pages={pages} total={total} noun="guilds" />
      </Section>
    </>
  );
}

function GuildRow({ guild, onChanged }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="cp-report"
      data-open={open ? '' : undefined}
      data-state={guild.moved_to ? 'moved' : (guild.gone ? 'gone' : undefined)}
    >
      <button type="button" className="cp-report__head" onClick={() => setOpen((v) => !v)}>
        <span className="cp-report__title">
          {guild.moved_to ? <Pill tone="accent">moved away</Pill> : null}
          {guild.gone ? <Pill tone="warn">gone</Pill> : null}
          <span className="truncate">{guild.name}</span>
          {guild.alias ? <span className="cp-report__meta truncate">{guild.alias}</span> : null}
        </span>
        <span className="cp-report__meta">
          {`${count(guild.members)} members · ${count(guild.channels)} channels · `
            + `${count(guild.messages)} messages`}
        </span>
      </button>
      {open ? <GuildDetail guild={guild} onChanged={onChanged} /> : null}
    </div>
  );
}

function GuildDetail({ guild, onChanged }) {
  const { home, stepUp } = useControlPlane();
  const detail = useLive(() => home.adminGuild(guild.id), { interval: 60_000 });
  const d = detail.data;
  const g = d?.guild || guild;
  const owner = d?.owner;

  return (
    <div className="cp-report__body">
      {g.moved_to ? (
        <Notice tone="accent">
          <div className="font-medium">This guild now lives on another server.</div>
          <div className="mt-0.5">
            {`Its members and every peer are being forwarded to ${g.moved_to}. What is left `
              + 'here is this server’s copy of the history, which nothing else in the product '
              + 'deletes.'}
          </div>
        </Notice>
      ) : null}

      {g.gone && !g.moved_to ? (
        <Notice tone="warn">
          This guild has been tombstoned as gone — deleted by its owner, or caught by a sunset.
          Its rows went with the delete; there is nothing here left to reclaim.
        </Notice>
      ) : null}

      <Facts>
        <Fact name="Guild" value={g.id} mono />
        <Fact name="Name" value={g.name} />
        <Fact name="Alias" value={g.alias} />
        <Fact
          name="Owner"
          value={owner ? (owner.display_name || owner.user_id) : g.owner_user_id}
          why={owner && owner.local === false
            ? 'This owner’s home is another server, so they are not in the accounts pane and '
              + 'nothing on this console can suspend them.'
            : (owner?.deactivated
              ? 'This owner’s account is switched off. The guild keeps running regardless.'
              : undefined)}
        />
        <Fact name="Created" value={present(g.created_at) ? clock(g.created_at, true) : ABSENT} />
        <Fact
          name="Last message"
          value={present(d?.last_message_at) ? clock(d.last_message_at, true) : ABSENT}
          why="When anything was last posted anywhere in the guild. The one number that says
            whether a large guild is large and busy or large and abandoned."
        />
        <Fact name="Members" value={count(g.members)} />
        <Fact
          name="From other servers"
          value={count(d?.remote_members)}
          why="Members whose home is elsewhere. Worth reading before defederating a domain:
            this is how much of the guild would go with it."
        />
        <Fact name="Banned" value={count(d?.banned_members)} />
        <Fact name="Channels" value={count(g.channels)} />
        <Fact name="Threads" value={count(d?.threads)} />
        <Fact name="Roles" value={count(d?.roles)} />
        <Fact name="Invites" value={count(d?.invites)} />
        <Fact name="Emojis" value={count(d?.emojis)} />
        <Fact name="Stickers" value={count(d?.stickers)} />
        <Fact
          name="Messages"
          value={count(g.messages)}
          why="Live rows in the hot table only. History that has been archived is counted
            separately below, so a guild whose past has all moved to cold storage does not look
            larger in the database than it is."
        />
        <Fact
          name="Archived"
          value={g.archived_segments
            ? `${count(g.archived_segments)} segments · ${size(g.archived_bytes)}`
            : ABSENT}
          why="Cold segments on disk, written by the archive job on the storage pane."
        />
        <Fact
          name="Reports against"
          value={count(d?.reports_against)}
          why="Reports filed against the guild itself rather than against a message in it.
            Whether this is the first complaint or the eleventh."
        />
        {g.moved_to ? <Fact name="Moved to" value={g.moved_to} mono /> : null}
      </Facts>

      {detail.error ? (
        <Hint>
          The counts above are the ones that came with the list: the server did not answer the
          per-guild query.
        </Hint>
      ) : null}

      {g.moved_to ? (
        <div className="cp-bar">
          <DangerAction
            label="Reclaim the space"
            title={`Erase this server’s copy of ${g.name}`}
            body={(
              <div className="flex flex-col gap-2">
                <p>
                  {`Every message, attachment and archived segment this server still holds for `
                    + `${g.name} will be deleted. That is ${count(g.messages)} live messages and `
                    + `${size(g.archived_bytes)} of archive. It cannot be undone from here.`}
                </p>
                <p>
                  {`The guild itself is not affected: it lives on ${g.moved_to} now, and its `
                    + 'copy of the history is its own. The forwarding address stays, so members '
                    + 'and other servers keep being pointed at the right place.'}
                </p>
              </div>
            )}
            confirmLabel="Erase the local copy"
            run={() => home.adminPurgeGuild(g.id)}
            done="Reclaimed. The forwarding address is still standing."
            onDone={() => { detail.reload(); onChanged(); }}
          />
          <Elevation stepUp={stepUp} />
          <Hint className="cp-bar__hint">
            Only offered for a guild that has moved. There is no way to delete a guild that is
            still here from this console — that belongs to its owner.
          </Hint>
        </div>
      ) : null}
    </div>
  );
}
