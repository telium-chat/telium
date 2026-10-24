import { useEffect, useRef, useState } from 'react';
import { ModalShell, Notice, Spinner, Button } from '../../components/index.js';
import { renderContent } from '../../lib/markdown.jsx';
import { openExternal } from '../../lib/platform.js';
import {
  cachedChangelog, CHANGELOG_PAGE, markRead, parseChangelog, refreshChangelog,
} from '../../lib/changelog.js';

export function ChangelogDialog({ onClosed }) {
  const [state, setState] = useState(() => cachedChangelog());
  const [refreshing, setRefreshing] = useState(true);
  const [failed, setFailed] = useState(false);

  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  useEffect(() => () => { onClosedRef.current?.(); }, []);

  useEffect(() => {
    let alive = true;
    refreshChangelog().then((parsed) => {
      if (!alive) return;
      setRefreshing(false);
      if (parsed) {
        setFailed(false);
        setState(parsed);
      } else {
        setFailed(true);
      }
    });
    return () => { alive = false; };
  }, []);

  const parsed = state;
  const marked = useRef(null);
  useEffect(() => {
    if (parsed && marked.current !== parsed.latest) {
      marked.current = parsed.latest;
      markRead(parsed.latest, null);
    }
  }, [parsed?.latest]);

  return (
    <ModalShell
      title="What's new"
      subtitle="What has changed in Telium lately."
      bodyClassName="max-w-2xl"
    >
      {parsed ? (
        <div className="flex flex-col gap-6 pb-2">
          {failed && !refreshing ? (
            <Notice tone="warn">
              Couldn't fetch the latest changelog just now — showing your saved copy.
            </Notice>
          ) : null}
          {parsed.sections.map((section) => (
            <ChangelogSection key={section.heading} section={section} />
          ))}
          <div className="border-t border-border pt-3">
            <Button
              variant="ghost"
              onClick={() => { openExternal(CHANGELOG_PAGE).catch(() => {}); }}
            >
              Full changelog on GitHub
            </Button>
          </div>
        </div>
      ) : refreshing ? (
        <div className="flex items-center justify-center gap-3 py-16 text-muted">
          <Spinner />
          <span>Fetching what's new…</span>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3 py-6">
          <Notice tone="warn">
            The changelog couldn't be fetched, and there is no saved copy on this device yet.
          </Notice>
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => {
                setRefreshing(true);
                setFailed(false);
                refreshChangelog().then((next) => {
                  setRefreshing(false);
                  if (next) { setFailed(false); setState(next); } else { setFailed(true); }
                });
              }}
            >
              Try again
            </Button>
            <Button onClick={() => { openExternal(CHANGELOG_PAGE).catch(() => {}); }}>
              Open on GitHub
            </Button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function ChangelogSection({ section }) {
  const blocks = [];
  let list = null;
  for (const block of section.blocks) {
    if (block.kind === 'bullet') {
      list ??= [];
      list.push(block.text);
      continue;
    }
    if (list) { blocks.push({ kind: 'list', items: list }); list = null; }
    blocks.push(block);
  }
  if (list) blocks.push({ kind: 'list', items: list });

  return (
    <section>
      <h3 className="text-sm font-semibold text-foreground">{section.heading}</h3>
      <div className="mt-2 flex flex-col gap-2 text-sm leading-relaxed text-muted">
        {blocks.map((block, i) => {
          if (block.kind === 'subheading') {
            return (
              <h4 key={i} className="mt-1 text-xs font-semibold uppercase tracking-wide opacity-70">
                {block.text}
              </h4>
            );
          }
          if (block.kind === 'list') {
            return (
              <ul key={i} className="flex list-disc flex-col gap-1 ps-5">
                {block.items.map((item, j) => (
                  <li key={j}>{renderContent(item)}</li>
                ))}
              </ul>
            );
          }
          return <p key={i}>{renderContent(block.text)}</p>;
        })}
      </div>
    </section>
  );
}
