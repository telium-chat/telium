// Reports become a pre-filled issue on the tracker; nothing leaves the device until the user opens the link. `deliver` is the seam a submission endpoint would replace. Report bodies are English and skip the catalogue: maintainers read them, and the headings match `.github/ISSUE_TEMPLATE/` (pinned by `src/test/feedback.test.js`).

import { buildLine } from './build.js';
import { collect, routeShape, toMarkdown } from './diagnostics.js';

const ISSUE_BASE = 'https://github.com/telium-chat/telium/issues/new';

// GitHub's practical ceiling for a GET is ~8k characters; stay well under it.
const MAX_URL_LENGTH = 7800;

// A report whose diagnostics did not fit still files and says so; the clipboard copy (`reportText`) is never clipped.
const MIN_BODY_LENGTH = 200;

/// `other` files unlabeled on purpose: there is no label for "something else".
export const FEEDBACK_KINDS = ['bug', 'idea', 'other'];

const KIND_LABEL = { bug: 'bug', idea: 'enhancement' };

/// Mirrors the tracker's issue forms so the same triage works over both.
const KIND_SHAPE = {
  bug: {
    descriptionHeading: 'What happened',
    descriptionPrompt: 'What went wrong instead?',
    otherHeading: 'What I was doing',
    otherPlaceholder: 'Replace this line: what were you doing when this happened?',
  },
  idea: {
    descriptionHeading: 'Proposed idea',
    descriptionPrompt: 'What would you like to happen? "How" is useful but optional.',
    otherHeading: 'Problem',
    otherPlaceholder: 'Replace this line: what are you trying to do that this would help with?',
  },
  other: {
    descriptionHeading: 'Feedback',
    descriptionPrompt: "What's on your mind?",
  },
};

const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}\n... truncated` : text);

function environmentLines() {
  const nav = typeof navigator === 'undefined' ? {} : navigator;
  const route = typeof location === 'undefined'
    ? null
    // The shape of the route, not the route: this goes into a public issue, and `/channels/:id` locates the bug as well as a real id.
    : routeShape(location.pathname + location.hash);
  return [
    `- Build: \`${buildLine()}\``,
    route ? `- Route: \`${route}\`` : null,
    `- User agent: \`${nav.userAgent || 'unknown'}\``,
    `- When: ${new Date().toISOString()}`,
  ].filter(Boolean);
}

/// Diagnostics go through the same allowlisted collector as Copy diagnostics. An empty `context` keeps the heading's placeholder comment.
export async function buildReport({
  store, kind, title, description, context = '', contact = '', includeDiagnostics = false,
}) {
  const shape = KIND_SHAPE[kind] || KIND_SHAPE.other;
  const sections = [];

  if (shape.otherHeading) {
    const said = String(context || '').trim();
    sections.push([
      `### ${shape.otherHeading}`,
      '',
      said ? clip(said, 2000) : `<!-- ${shape.otherPlaceholder} -->`,
    ]);
  }
  sections.push([`### ${shape.descriptionHeading}`, '', clip(String(description || '').trim(), 6000)]);

  const env = environmentLines();
  // No account identity: only what the reporter typed, and only if they want a reply.
  if (String(contact || '').trim()) env.splice(1, 0, `- Contact: ${contact.trim()}`);
  sections.push(['### Environment', '', ...env]);

  if (includeDiagnostics) {
    try {
      const report = await collect(store);
      sections.push(['### Diagnostics', '', toMarkdown(report)]);
    } catch {
      // The collector failing is not the report failing.
      sections.push(['### Diagnostics', '', '(collecting diagnostics failed)']);
    }
  }

  return {
    // An empty title falls back to the reporter's first line.
    title: clip(String(title || '').trim() || derivedTitle(description), 110),
    body: sections.map((lines) => lines.join('\n')).join('\n\n'),
  };
}

function derivedTitle(description) {
  const line = String(description || '').trim().split('\n')[0].trim();
  return line.length > 70 ? `${line.slice(0, 67)}...` : line;
}

/// Never clipped: the clipboard has no URL ceiling.
export function reportText({ title, body }) {
  return `${title}\n\n${body}`;
}

export function reportUrl({ kind, title, body }) {
  const params = new URLSearchParams();
  const label = KIND_LABEL[kind];
  if (label) params.set('labels', label);
  params.set('title', title);
  // Cut the body, never the title or environment lines: a truncated trace still locates a bug, a refused URL does not.
  let candidate = body;
  params.set('body', candidate);
  let encoded = `${ISSUE_BASE}?${params}`;
  while (encoded.length > MAX_URL_LENGTH && candidate.length > MIN_BODY_LENGTH) {
    candidate = clip(candidate, Math.floor(candidate.length * 0.75));
    params.set('body', candidate);
    encoded = `${ISSUE_BASE}?${params}`;
  }
  return encoded;
}

/// No store is read and no request is made: the store may be what just threw.
export function crashReportUrl(error, stack) {
  const body = [
    '### What I was doing',
    '',
    '<!-- Replace this line: what were you doing when the screen broke? -->',
    '',
    '### Error',
    '',
    '```',
    clip(String(error?.stack || error?.message || error), 2400),
    '```',
    '',
    '### Component stack',
    '',
    '```',
    clip((stack || '').trim() || '(none captured)', 2400),
    '```',
    '',
    '### Environment',
    '',
    ...environmentLines(),
  ].join('\n');
  const title = `Render error: ${String(error?.message || error).slice(0, 110)}`;
  return `${ISSUE_BASE}?labels=bug&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
