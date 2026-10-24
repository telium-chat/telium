import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('../hooks/useToast.jsx', () => ({ toast: (...args) => toast(...args) }));

const { copyToClipboard, copyWithEmoji } = await import('../lib/clipboard.js');

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalExec = document.execCommand;

function withClipboard(writeText) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

beforeEach(() => {
  toast.mockClear();
});

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete navigator.clipboard;
  document.execCommand = originalExec;
  document.body.innerHTML = '';
});

describe('copyToClipboard', () => {
  it('uses the modern API when it is there, and says what was copied', async () => {
    const writeText = vi.fn(async () => {});
    withClipboard(writeText);

    await expect(copyToClipboard('https://telium.chat/i/abc', 'Invite link')).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith('https://telium.chat/i/abc');
    expect(toast).toHaveBeenCalledWith('Invite link copied.');
  });

  it('falls back to a selection copy where the modern API is denied', async () => {
    withClipboard(vi.fn(async () => { throw new Error('NotAllowedError'); }));
    let copied = null;
    document.execCommand = vi.fn(() => {
      copied = document.activeElement.value;
      return true;
    });

    await expect(copyToClipboard('a secret', 'Token')).resolves.toBe(true);

    expect(copied).toBe('a secret');
    expect(toast).toHaveBeenCalledWith('Token copied.');
  });

  it('falls back where the modern API is absent entirely', async () => {
    withClipboard(undefined);
    document.execCommand = vi.fn(() => true);

    await expect(copyToClipboard('abc', 'Code')).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('leaves no scratch element behind on the page', async () => {
    withClipboard(undefined);
    document.execCommand = vi.fn(() => true);

    await copyToClipboard('abc', 'Code');

    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('gives focus back to whatever the reader was in', async () => {
    withClipboard(undefined);
    document.execCommand = vi.fn(() => true);
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();

    await copyToClipboard('abc', 'Code');

    expect(document.activeElement).toBe(field);
  });

  it('says so, and answers false, when neither path worked', async () => {
    withClipboard(undefined);
    document.execCommand = vi.fn(() => false);

    await expect(copyToClipboard('abc', 'Code')).resolves.toBe(false);

    expect(toast).toHaveBeenCalledWith('Could not reach the clipboard.');
    expect(toast).not.toHaveBeenCalledWith('Code copied.');
  });

  it('answers false rather than throwing when the selection copy throws', async () => {
    withClipboard(undefined);
    document.execCommand = vi.fn(() => { throw new Error('unsupported'); });

    await expect(copyToClipboard('abc', 'Code')).resolves.toBe(false);
    expect(toast).toHaveBeenCalledWith('Could not reach the clipboard.');
  });

  it('copies an empty string rather than the word "null"', async () => {
    const writeText = vi.fn(async () => {});
    withClipboard(writeText);

    await copyToClipboard(null, 'Nothing');

    expect(writeText).toHaveBeenCalledWith('');
  });
});

describe('copying a selection with emoji in it', () => {
  function select(html) {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.appendChild(root);
    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return root;
  }

  function copy() {
    const written = new Map();
    const event = {
      preventDefault: vi.fn(),
      clipboardData: { setData: (type, value) => written.set(type, value) },
    };
    copyWithEmoji(event);
    return { event, plain: written.get('text/plain'), html: written.get('text/html') };
  }

  it('pastes the character the picture was standing for', () => {
    select('<span>ship it <img class="emoji" alt="\u{1F680}" src="1f680.svg"> now</span>');

    const { event, plain } = copy();

    expect(event.preventDefault).toHaveBeenCalled();
    expect(plain).toBe('ship it \u{1F680} now');
  });

  it('names a custom emoji, which has no character to paste', () => {
    select('<span>nice <img class="emoji" alt=":shipit:" src="/emoji/01H"></span>');

    expect(copy().plain).toBe('nice :shipit:');
  });

  it('leaves the markup flavour with its pictures in it', () => {
    select('<strong>bold</strong> <img class="emoji" alt="\u{1F680}" src="1f680.svg">');

    const { html } = copy();

    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('class="emoji"');
  });

  it('stays out of a copy that has no emoji in it', () => {
    select('<span>just words</span>');

    const { event, plain, html } = copy();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(plain).toBeUndefined();
    expect(html).toBeUndefined();
  });

  it('leaves an avatar or an attachment alone', () => {
    select('<span>look <img class="thumb" alt="a cat" src="cat.png"></span>');

    expect(copy().event.preventDefault).not.toHaveBeenCalled();
  });

  it('leaves no clone of the selection behind on the page', () => {
    select('<span>hi <img class="emoji" alt="\u{1F680}" src="1f680.svg"></span>');

    copy();

    expect(document.querySelectorAll('img.emoji')).toHaveLength(1);
  });

  it('does nothing with a caret and no selection', () => {
    select('<span>hi <img class="emoji" alt="\u{1F680}" src="1f680.svg"></span>');
    document.getSelection().collapseToStart();

    expect(copy().event.preventDefault).not.toHaveBeenCalled();
  });
});
