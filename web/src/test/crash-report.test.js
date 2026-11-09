import { describe, expect, it } from 'vitest';
import { crashReportUrl } from '../lib/feedback.js';

describe('render crash issue reports', () => {
  it('names the minified desktop JS bundle and exact position', () => {
    const error = new TypeError('t is not a function');
    error.stack = 'TypeError: t is not a function\\n    at CR (file:///tmp/.mount_TeliumPjFJdg/resources/app.asar/renderer/assets/index-BHmKnswn.js:42:101553)';
    const url = new URL(crashReportUrl(error, 'at CR (minified component)'));
    const body = url.searchParams.get('body');

    expect(url.searchParams.get('labels')).toBe('bug');
    expect(body).toContain('### Crash location');
    expect(body).toContain('`index-BHmKnswn.js:42:101553`');
    expect(body.indexOf('### Crash location')).toBeLessThan(body.indexOf('### Error'));
    expect(body).toContain('### Component stack');
  });

  it('caps huge traces to a GitHub-compatible URL without losing the build context', () => {
    const error = new TypeError('t is not a function');
    error.stack = 'TypeError: t is not a function\\n    at CR (file:///tmp/mounted/renderer/assets/index-Crash.js:42:101553)\\n'
      + '    at CR (file:///tmp/mounted/renderer/assets/index-Crash.js:42:101553)\\n'.repeat(200);
    const urlText = crashReportUrl(error, 'at component'.repeat(500));
    const body = new URL(urlText).searchParams.get('body');

    expect(urlText.length).toBeLessThanOrEqual(7800);
    expect(body).toContain('### Crash location');
    expect(body).toContain('`index-Crash.js:42:101553`');
    expect(body).toContain('### Environment');
  });

  it('still reports errors with no JavaScript stack frame', () => {
    const body = new URL(crashReportUrl(new Error('unknown'), '')).searchParams.get('body');
    expect(body).not.toContain('### Crash location');
    expect(body).toContain('unknown');
  });
});
