import { cn } from '../lib/cn.js';
import { BIO_MAX_FALLBACK, clampBio } from '../lib/bio.js';
import { BIO, renderContent } from '../lib/markdown.jsx';
import { useOptionalStore } from '../hooks/useStore.jsx';

const URL = /https?:\/\/[^\s<]+/g;

const trim = (url) => {
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1];
    if ('.,;:!?'.includes(c)) { end -= 1; continue; }
    if (c === ')') {
      const body = url.slice(0, end);
      const opens = (body.match(/\(/g) || []).length;
      const closes = (body.match(/\)/g) || []).length;
      if (closes > opens) { end -= 1; continue; }
    }
    break;
  }
  return url.slice(0, end);
};

const LABEL_MAX = 56;
const label = (url) => {
  const bare = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return bare.length > LABEL_MAX ? `${bare.slice(0, LABEL_MAX - 1)}…` : bare;
};

const prose = (run, key) => <span key={key}>{renderContent(run, BIO)}</span>;

export function BioText({ children, className }) {
  const store = useOptionalStore();
  const limit = store?.bioLimit ? store.bioLimit() : BIO_MAX_FALLBACK;
  const text = typeof children === 'string' ? clampBio(children, limit) : '';
  if (!text) return children ?? null;

  const out = [];
  let last = 0;
  let m;
  URL.lastIndex = 0;
  while ((m = URL.exec(text))) {
    const url = trim(m[0]);
    if (!url) continue;
    if (m.index > last) out.push(prose(text.slice(last, m.index), `t${last}`));
    out.push(
      <a key={`u${m.index}`} href={url} target="_blank" rel="noreferrer noopener nofollow" title={url} className="bio-link">
        {label(url)}
      </a>,
    );
    last = m.index + url.length;
  }
  if (last < text.length) out.push(prose(text.slice(last), `t${last}`));
  return <span className={cn('md', className)}>{out}</span>;
}
