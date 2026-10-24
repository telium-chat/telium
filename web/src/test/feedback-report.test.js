import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildReport, crashReportUrl, reportText, reportUrl } from '../lib/feedback.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = (relative) => resolve(here, '../../..', relative);

const templateLabels = (file) => new Set([...readFileSync(
  repo(`.github/ISSUE_TEMPLATE/${file}`), 'utf8',
).matchAll(/^\s+label: (.+)$/gm)].map((m) => m[1].replace(/^'|'$/g, '')));

const BUG_TEMPLATE = templateLabels('bug_report.yml');
const IDEA_TEMPLATE = templateLabels('feature_request.yml');

const headingsIn = (body) => [...body.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
const paramsOf = (url) => new URL(url).searchParams;

describe('crashReportUrl', () => {
  it('keeps the shape the tracker triages on', () => {
    const url = crashReportUrl(new Error('boom'), 'at Component');
    const params = paramsOf(url);
    expect(url.startsWith('https://github.com/telium-chat/telium/issues/new')).toBe(true);
    expect(params.get('labels')).toBe('bug');
    expect(params.get('title')).toContain('Render error: boom');
    const body = params.get('body');
    expect(headingsIn(body)).toEqual([
      'What I was doing', 'Error', 'Component stack', 'Environment',
    ]);
    expect(body).toContain('boom');
    expect(body).toContain('at Component');
    expect(body).toContain('- Build: `');
    expect(body).toContain('- Route: `');
  });

  it('truncates a pathological stack instead of losing the report', () => {
    const url = crashReportUrl({ message: 'boom', stack: 'x'.repeat(9999) }, 'y'.repeat(9999));
    expect(url.length).toBeLessThan(8000);
    expect(paramsOf(url).get('body')).toContain('... truncated');
  });
});

describe('buildReport', () => {
  it('a bug leaves the doing line to the reporter and fills what happened', async () => {
    const { title, body } = await buildReport({
      store: null,
      kind: 'bug',
      title: 'Messages will not send',
      description: 'They spin forever on one server.',
      includeDiagnostics: false,
    });
    expect(title).toBe('Messages will not send');
    expect(headingsIn(body)).toEqual(['What I was doing', 'What happened', 'Environment']);
    expect(body).toContain('<!-- Replace this line: what were you doing when this happened? -->');
    expect(body).toContain('They spin forever on one server.');
    expect(body).not.toContain('### Diagnostics');
  });

  it('context typed in the client files under the doing heading, not as a placeholder', async () => {
    const { body } = await buildReport({
      store: null,
      kind: 'bug',
      title: 'Messages will not send',
      context: 'I was dragging a channel while the socket reconnected.',
      description: 'They spin forever on one server.',
      includeDiagnostics: false,
    });
    expect(headingsIn(body)).toEqual(['What I was doing', 'What happened', 'Environment']);
    expect(body).toContain(
      '### What I was doing\n\nI was dragging a channel while the socket reconnected.',
    );
    expect(body).not.toContain('<!-- Replace this line');
    expect(body).toContain('### What happened\n\nThey spin forever on one server.');
  });

  it("an idea's problem section takes the reporter's words the same way", async () => {
    const { body } = await buildReport({
      store: null,
      kind: 'idea',
      title: 'Threads should fold by default',
      context: 'I follow twelve channels and threads bury the newest message.',
      description: 'Fold them by default with a badge for new replies.',
      includeDiagnostics: false,
    });
    expect(headingsIn(body)).toEqual(['Problem', 'Proposed idea', 'Environment']);
    expect(body).toContain(
      '### Problem\n\nI follow twelve channels and threads bury the newest message.',
    );
  });

  it('diagnostics land only when asked for', async () => {
    const { body } = await buildReport({
      store: null,
      kind: 'bug',
      title: '',
      description: 'it broke',
      includeDiagnostics: true,
    });
    expect(headingsIn(body)).toContain('Diagnostics');
    expect(body).toContain('```json');
  });

  it('an idea files under the enhancement headings', async () => {
    const { title, body } = await buildReport({
      store: null,
      kind: 'idea',
      title: 'Threads should fold by default',
      description: 'They bury the newest message.',
      includeDiagnostics: false,
    });
    expect(headingsIn(body)).toEqual(['Problem', 'Proposed idea', 'Environment']);
    expect(title).toBe('Threads should fold by default');
  });

  it('a missing title derives from the description', async () => {
    const { title } = await buildReport({
      store: null,
      kind: 'other',
      title: '',
      description: 'The icon is ugly\nand here is more detail',
    });
    expect(title).toBe('The icon is ugly');
  });

  it('a long first line is cut where a tracker title wants cutting', async () => {
    const { title } = await buildReport({
      store: null,
      kind: 'other',
      title: '',
      description: 'x'.repeat(300),
    });
    expect(title.length).toBe(70);
  });

  it('the clipboard copy is the title over the body, unclipped', async () => {
    const report = await buildReport({
      store: null, kind: 'bug', title: 'A title', description: 'The details.', includeDiagnostics: true,
    });
    const text = reportText(report);
    expect(text.startsWith('A title\n\n')).toBe(true);
    expect(text).toContain('```json');
  });

  it('contact appears only when given, and inside Environment', async () => {
    const withContact = await buildReport({ store: null, kind: 'bug', title: '', description: 'd', contact: 'me@example' });
    const withoutContact = await buildReport({ store: null, kind: 'bug', title: '', description: 'd' });
    const env = (body) => body.slice(body.indexOf('### Environment'));
    expect(env(withContact.body)).toContain('- Contact: me@example');
    expect(env(withoutContact.body)).not.toContain('Contact:');
    expect(env(withContact.body).indexOf('Contact')).toBeLessThan(env(withContact.body).indexOf('User agent'));
  });
});

describe('reportUrl', () => {
  it('labels a bug and an idea, and leaves something else unlabeled', () => {
    expect(paramsOf(reportUrl({ kind: 'bug', title: 't', body: 'b' })).get('labels')).toBe('bug');
    expect(paramsOf(reportUrl({ kind: 'idea', title: 't', body: 'b' })).get('labels')).toBe('enhancement');
    expect(paramsOf(reportUrl({ kind: 'other', title: 't', body: 'b' })).get('labels')).toBe(null);
  });

  it('carries the title and body through', () => {
    const params = paramsOf(reportUrl({ kind: 'bug', title: 'a title', body: 'a body' }));
    expect(params.get('title')).toBe('a title');
    expect(params.get('body')).toBe('a body');
  });

  it('clips a huge body until the link is openable', () => {
    const url = reportUrl({ kind: 'bug', title: 't', body: 'y'.repeat(200000) });
    expect(url.length).toBeLessThan(7801);
    expect(paramsOf(url).get('body')).toContain('... truncated');
  });
});

describe('the report headings are the template headings', () => {
  it('for a bug', async () => {
    const { body } = await buildReport({
      store: null, kind: 'bug', title: '', description: 'd', includeDiagnostics: true,
    });
    for (const heading of headingsIn(body)) {
      expect(BUG_TEMPLATE.has(heading), `heading "${heading}" is not a field in bug_report.yml`).toBe(true);
    }
  });

  it('for an idea', async () => {
    const { body } = await buildReport({
      store: null, kind: 'idea', title: '', description: 'd', includeDiagnostics: true,
    });
    for (const heading of headingsIn(body)) {
      expect(IDEA_TEMPLATE.has(heading), `heading "${heading}" is not a field in feature_request.yml`).toBe(true);
    }
  });

  it('and "something else" files as a blank issue, so it carries no template-only sections', async () => {
    const { body } = await buildReport({
      store: null, kind: 'other', title: '', description: 'd', includeDiagnostics: true,
    });
    expect(headingsIn(body)).toEqual(['Feedback', 'Environment', 'Diagnostics']);
  });
});
