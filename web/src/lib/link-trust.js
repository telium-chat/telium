// Where a link goes and whether the reader has agreed to go there. The link text is no evidence of its destination, so a click leaving the signed-in servers names the real host first. No React.

function labels(host) {
  return String(host || '').toLowerCase().split('.').filter(Boolean);
}

/// Other scripts are shown as punycode: a lookalike is only a lookalike while allowed to look like something.
const SAFE_SCRIPTS = /^[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Common}\p{Script=Inherited}]*$/u;

const SCRIPTS = ['Latin', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Cyrillic', 'Greek', 'Arabic', 'Hebrew', 'Thai', 'Devanagari']
  .map((name) => [name, new RegExp(`\\p{Script=${name}}`, 'u')]);
const NEUTRAL = /[\p{Script=Common}\p{Script=Inherited}]/u;

/// Shown as written only when all one script (plus digits and hyphens); mixing scripts is the homograph trick.
function singleScript(label) {
  if (!SAFE_SCRIPTS.test(label)) return false;
  const scripts = new Set();
  for (const ch of label) {
    if (NEUTRAL.test(ch)) continue;
    for (const [name, re] of SCRIPTS) {
      if (re.test(ch)) { scripts.add(name); break; }
    }
  }
  // Japanese is written in three alphabets at once, so those three count as one.
  for (const kana of ['Hiragana', 'Katakana']) {
    if (scripts.has(kana) && scripts.has('Han')) scripts.delete(kana);
  }
  return scripts.size <= 1;
}

/// `host` is what to show; `ascii` is what the browser resolves (`URL.hostname` is already punycode).
export function destinationOf(raw, base = undefined) {
  let url;
  try { url = new URL(String(raw), base); } catch { return null; }
  if (!/^https?:$/i.test(url.protocol)) return null;
  const ascii = url.hostname.toLowerCase();
  if (!ascii) return null;

  // An `xn--` label means the readable spelling was not ASCII; it stays encoded on screen.
  const punycoded = labels(ascii).some((l) => l.startsWith('xn--'));

  return {
    href: url.href,
    // Credentials in a URL (`https://telium.example@evil.test/`) are reported rather than dropped.
    userinfo: url.username ? decodeURIComponent(url.username) : '',
    host: ascii,
    ascii,
    punycoded,
    disguised: punycoded || !labels(ascii).every(singleScript) || Boolean(url.username),
    path: `${url.pathname}${url.search}` === '/' ? '' : `${url.pathname}${url.search}`,
  };
}

/// Home server and every guild server held; stopping readers on the way to their own server teaches them to click through.
export function ownHosts(store) {
  const out = new Set();
  const add = (value) => {
    const found = destinationOf(value) || destinationOf(`https://${value}`);
    if (found) out.add(found.host);
  };
  if (typeof window !== 'undefined' && window.location?.host) add(`https://${window.location.host}`);
  const session = store?.session;
  if (session?.home) { add(session.home.base); add(session.home.domain); }
  for (const [domain, entry] of Object.entries(session?.servers || {})) {
    add(domain);
    if (entry?.base) add(entry.base);
  }
  for (const [domain, api] of store?.apis || []) {
    add(domain);
    if (api?.base) add(api.base);
  }
  return out;
}

/// Kept in prefs so they sync sealed to other devices.
export function trustedDomains(store) {
  const list = store?.prefs?.trustedDomains;
  return Array.isArray(list) ? list : [];
}

/// An entry covers itself and its subdomains, compared by whole labels: trusting `example.com` must not cover `example.com.evil.test`.
function covers(entry, host) {
  return host === entry || host.endsWith(`.${entry}`);
}

export function isTrustedHost(store, host) {
  if (!host) return false;
  if (ownHosts(store).has(host)) return true;
  return trustedDomains(store).some((entry) => covers(entry, host));
}

/// Capped because the list is synced and would otherwise become a browsing history.
export const MAX_TRUSTED_DOMAINS = 200;

export function trustHost(store, host) {
  const found = destinationOf(`https://${host}`);
  if (!found || !store?.prefs) return;
  const list = trustedDomains(store).filter((entry) => !covers(found.host, entry));
  if (list.some((entry) => covers(entry, found.host))) return;
  list.unshift(found.host);
  store.prefs.trustedDomains = list.slice(0, MAX_TRUSTED_DOMAINS);
  store.savePrefs();
}

export function forgetTrustedHost(store, host) {
  if (!store?.prefs) return;
  store.prefs.trustedDomains = trustedDomains(store).filter((entry) => entry !== host);
  store.savePrefs();
}

export function needsConfirmation(store, raw) {
  const found = destinationOf(raw);
  if (!found) return null;
  return isTrustedHost(store, found.host) ? null : found;
}
