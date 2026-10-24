import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalHost, ModalProvider } from '../hooks/useModal.jsx';
import { AppMessage } from '../components/message-ui/index.js';
import { EphemeralMessages } from '../views/chat/EphemeralMessages.jsx';
import {
  accentFrom, forgetInteractions, handleInteractionFrame, normalizeCards,
  plainText, safeLinkUrl, SILENCE_MS,
} from '../lib/interactions.js';

const HOME = 'https://guild.example';
const CAMO = `${HOME}/_telium/v1/camo`;

function fakeStore({ post } = {}) {
  const handlers = new Map();
  return {
    session: { home: { base: HOME, domain: 'guild.example' }, servers: {} },
    apis: new Map(),
    posted: [],
    patched: [],
    on(event, fn) {
      const set = handlers.get(event) || new Set();
      set.add(fn);
      handlers.set(event, set);
      return () => set.delete(fn);
    },
    emit(event, payload) {
      for (const fn of handlers.get(event) || []) fn(payload);
    },
    apiForChannel() {
      return {
        post: async (path, body) => {
          this.posted.push({ path, body });
          return post ? post(path, body) : null;
        },
      };
    },
    patchMessage(next) { this.patched.push(next); },
  };
}

const BOT = { is_bot: true, display_name: 'Ping Bot' };

function show(msg, { store = fakeStore(), member = BOT } = {}) {
  const view = render(
    <StoreProvider store={store}>
      <ModalProvider>
        <AppMessage
          msg={{ id: 'm1', channel_id: 'c1', author: '@ping:guild.example', ...msg }}
          member={member}
          base={HOME}
        />
        <ModalHost />
      </ModalProvider>
    </StoreProvider>,
  );
  return { ...view, store };
}

const row = (...components) => [{ type: 'action_row', components }];

beforeEach(() => { act(() => { forgetInteractions(); }); });
afterEach(() => { vi.useRealTimers(); act(() => { forgetInteractions(); }); });

describe('a string an application wrote', () => {
  it('is a text child and never markup', () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const { container } = show({
      cards: [{ title: hostile, description: `<script>alert(2)</script>` }],
    });

    expect(screen.getByText(hostile)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).toContain('&lt;img src=x onerror=');
    expect(container.innerHTML).not.toContain('<img');
    expect(container.innerHTML).not.toContain('<script');
  });

  it('is clamped, so one label cannot set the width of the timeline', () => {
    const wall = 'A'.repeat(2000);
    show({ components: row({ type: 'button', style: 'primary', custom_id: 'go', label: wall }) });

    const button = screen.getByRole('button');
    expect(button.textContent.length).toBeLessThanOrEqual(81);
    expect(button.textContent.endsWith('…')).toBe(true);
  });

  it('loses the characters that let text lie about its own direction', () => {
    const clean = plainText('Open \u202Eeurots\u202C\u200B\u200B file', 80);
    expect(clean).not.toMatch(/[\u202A-\u202E\u200B-\u200F]/);
    expect(clean).toContain('Open');
  });

  it.each([
    ['\u00AD', 'the soft hyphen, which renders as nothing almost everywhere'],
    ['\u2060', 'the word joiner, a character with no glyph by definition'],
    ['\u2063', 'an invisible separator from the maths operators'],
    ['\u200B', 'a zero-width space'],
    ['\uFEFF', 'a byte-order mark loose in the middle of a string'],
    ['\u202E', 'a right-to-left override'],
    ['\u2066', 'a right-to-left isolate, which filters that know only the overrides miss'],
    ['\u{E0041}', 'a tag character, one letter of a whole shadow alphabet nothing draws'],
  ])('strips %j from a label, because it is %s', (ch) => {
    const clean = plainText(`real${ch}text`, 80);
    expect(clean).toBe('realtext');
  });

  it('keeps the characters that real text in real languages is spelled with', () => {
    const text = 'caf\u00e9 \u3053\u3093\u306B\u3061\u306F \u0645\u0631\u062D\u0628\u0627 \u{1F600}\u{1F3FD} e\u0301';
    expect(plainText(text, 200)).toBe(text);
  });

  it('keeps a subdivision flag, which is a real flag spelled with tag characters', () => {
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    expect(plainText(`${england} v ${scotland}`, 80)).toBe(`${england} v ${scotland}`);
    expect(plainText('\u{1F3F4} sail', 80)).toBe('\u{1F3F4} sail');
  });

  it('still eats a tag run that is only pretending to be a flag', () => {
    const unterminated = '\u{1F3F4}\u{E0070}\u{E0061}\u{E0079}\u{E006D}\u{E0065}';
    expect(plainText(`x${unterminated}`, 80)).toBe('x\u{1F3F4}');
    const noFlag = 'pay\u{E0070}\u{E0061}\u{E0079}\u{E007F}';
    expect(plainText(noFlag, 80)).toBe('pay');
  });

  it('cannot make a card out of nothing', () => {
    expect(normalizeCards([{ image: 'https://tracker.example/pixel.gif' }], { base: HOME })).toEqual([]);
  });
});

describe('a URL an application chose', () => {
  it('refuses javascript:, data: and everything that is not a web address', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'blob:https://guild.example/abc',
      'file:///etc/passwd',
      '/settings/account',
    ]) {
      expect(safeLinkUrl(hostile)).toBeNull();
    }
    expect(safeLinkUrl('https://docs.example/a')).toBe('https://docs.example/a');
  });

  it('keeps a refused link button on screen, dead, rather than dropping it', () => {
    show({
      components: row(
        { type: 'button', style: 'link', label: 'Click here', url: 'javascript:alert(1)' },
        { type: 'button', style: 'primary', custom_id: 'ok', label: 'Fine' },
      ),
    });

    const dead = screen.getByRole('button', { name: /Click here/ });
    expect(dead.hasAttribute('href')).toBe(false);
    expect(dead.disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Fine/ })).toBeTruthy();
  });

  it('draws an allowed link as a real anchor, so the external-link warning sees it', () => {
    show({
      components: row({
        type: 'button', style: 'link', label: 'Docs', url: 'https://docs.example/a',
      }),
    });

    const link = screen.getByRole('link', { name: /Docs/ });
    expect(link.getAttribute('href')).toBe('https://docs.example/a');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('title')).toBe('https://docs.example/a');
  });
});

describe('a picture an application referenced', () => {
  it('is drawn only through this server’s own proxy', () => {
    const { container } = show({
      cards: [{
        title: 'Weather',
        image: 'https://tracker.example/pixel.gif',
        thumbnail: `${CAMO}/abc123def456abc1`,
      }],
    });

    const sources = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(sources).not.toContain('https://tracker.example/pixel.gif');
    expect(sources).toContain(`${CAMO}/abc123def456abc1`);
  });

  it('refuses a proxy path hosted on the application’s own domain', () => {
    const cards = normalizeCards(
      [{ title: 'x', image: 'https://evil.example/_telium/v1/camo/abc' }],
      { store: fakeStore(), base: HOME },
    );
    expect(cards[0].image).toBeNull();
  });

  it('draws the two references the server resolves an image into, and nothing else', () => {
    const cards = normalizeCards([{
      title: 'Build',
      image: { kind: 'camo', url: `${CAMO}/abc123def456abc1`, width: 800, height: 200 },
      thumbnail: { kind: 'media', origin: 'guild.example', hash: 'abc123def456abc1' },
    }], { store: fakeStore(), base: HOME });

    expect(cards[0].image).toBe(`${CAMO}/abc123def456abc1`);
    expect(cards[0].thumbnail).toBe(`${HOME}/_telium/v1/media/abc123def456abc1`);
  });

  it('reads a foreign object through this server rather than from the server that owns it', () => {
    const cards = normalizeCards(
      [{ title: 'x', image: { kind: 'media', origin: 'other.example', hash: 'abc123def456abc1' } }],
      { store: fakeStore(), base: HOME },
    );
    expect(cards[0].image.startsWith(`${HOME}/_telium/v1/media/remote/`)).toBe(true);
    expect(cards[0].image).toContain('other.example');
  });

  it('refuses a resolved-looking reference pointing anywhere else', () => {
    const cards = normalizeCards([{
      title: 'x',
      image: { kind: 'camo', url: 'https://tracker.example/_telium/v1/camo/abc123def456abc1' },
      thumbnail: { kind: 'media', hash: '../../etc/passwd' },
    }], { store: fakeStore(), base: HOME });
    expect(cards[0].image).toBeNull();
    expect(cards[0].thumbnail).toBeNull();
  });

  it('clamps a colour to the twenty-four bits it claims to be', () => {
    expect(accentFrom(0xFF0000)).toBe('rgb(255 0 0)');
    expect(accentFrom(0xFFFFFFFF)).toBe('rgb(255 255 255)');
    expect(accentFrom('red; background: url(x)')).toBeNull();
  });
});

describe('the card, beside a link preview', () => {
  it('says which application composed it, in the client’s own words', () => {
    show({
      cards: [{ title: 'Ticket #4', description: 'Opened just now.', colour: 0x00FF00 }],
    }, { member: { is_bot: true, display_name: 'Ping Bot', nickname: 'Helpdesk' } });

    expect(screen.getByText('Helpdesk')).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Card from Helpdesk' })).toBeTruthy();
  });

  it('is not drawn at all under a name this client knows to be a person', () => {
    const { container } = show(
      { cards: [{ title: 'Sign in to continue' }], components: row({ type: 'button', style: 'primary', custom_id: 'x', label: 'Sign in' }) },
      { member: { is_bot: false, display_name: 'Mallory' } },
    );
    expect(container.textContent).toBe('');
  });
});

describe('the round trip', () => {
  it('holds the pressed control while the press is in flight and lets go when the answer lands', async () => {
    let settle;
    const store = fakeStore({ post: () => new Promise((resolve) => { settle = resolve; }) });
    show({ components: row({ type: 'button', style: 'primary', custom_id: 'go', label: 'Go' }) }, { store });

    const button = screen.getByRole('button', { name: /Go|Working/ });
    fireEvent.click(button);

    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'));
    expect(button.disabled).toBe(true);
    expect(store.posted[0].path).toBe('/_telium/v1/channels/c1/messages/m1/interact');
    expect(store.posted[0].body).toEqual({ custom_id: 'go' });

    await act(async () => { settle({ id: 'int-1', kind: 'component', local: true }); });
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'));

    await act(async () => {
      store.emit('dispatch', { t: 'MESSAGE_UPDATE', d: { id: 'm1', channel_id: 'c1', content: 'Done.' } });
    });
    await waitFor(() => expect(button.hasAttribute('aria-busy')).toBe(false));
  });

  it('keeps holding it when the application says it will answer later, long past the leash silence gets', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const store = fakeStore({ post: async () => ({ id: 'int-1', kind: 'component', local: false }) });
    show({ components: row({ type: 'button', style: 'primary', custom_id: 'go', label: 'Go' }) }, { store });

    const button = screen.getByRole('button', { name: /Go|Working/ });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute('data-phase')).toBe('sending'));

    await act(async () => {
      store.emit('dispatch', {
        t: 'INTERACTION_DEFERRED',
        d: { interaction_id: 'int-1', channel_id: 'c1', message_id: 'm1', ephemeral: false },
      });
    });
    await waitFor(() => expect(button.getAttribute('data-phase')).toBe('deferred'));

    await act(async () => { vi.advanceTimersByTime(SILENCE_MS * 4); });
    expect(button.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      store.emit('dispatch', { t: 'MESSAGE_UPDATE', d: { id: 'm1', channel_id: 'c1', content: 'Done.' } });
    });
    await waitFor(() => expect(button.hasAttribute('aria-busy')).toBe(false));
  });

  it('gives up on silence long before it gives up on a promise', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const store = fakeStore({ post: async () => ({ id: 'int-2', kind: 'component', local: false }) });
    show({ components: row({ type: 'button', style: 'primary', custom_id: 'go', label: 'Go' }) }, { store });

    const button = screen.getByRole('button', { name: /Go|Working/ });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'));

    await act(async () => { vi.advanceTimersByTime(SILENCE_MS + 10); });
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  it('releases a control when the application answers with a message instead of an edit', async () => {
    const store = fakeStore({ post: async () => ({ id: 'int-3', kind: 'component', local: false }) });
    show({ components: row({ type: 'button', style: 'primary', custom_id: 'go', label: 'Go' }) }, { store });

    const button = screen.getByRole('button', { name: /Go|Working/ });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'));

    await act(async () => {
      store.emit('dispatch', {
        t: 'MESSAGE_CREATE',
        d: { id: 'm2', channel_id: 'c1', reply_to: 'm1', content: 'Pong.' },
      });
    });
    await waitFor(() => expect(button.hasAttribute('aria-busy')).toBe(false));
  });

  it('sends a select\u2019s chosen value once, with the option\u2019s own id', async () => {
    const store = fakeStore({ post: async () => ({ id: 'int-4', kind: 'component', local: false }) });
    show({
      components: row({
        type: 'select',
        custom_id: 'pick',
        placeholder: 'Choose a team',
        options: [
          { label: 'Red', value: 'r', description: 'The red one' },
          { label: 'Blue', value: 'b' },
        ],
      }),
    }, { store });

    fireEvent.click(screen.getByRole('button', { name: /Choose a team/ }));
    const list = screen.getByRole('listbox');
    expect(list.getAttribute('aria-multiselectable')).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /Red/ }));

    await waitFor(() => expect(store.posted).toHaveLength(1));
    expect(store.posted[0].body).toEqual({ custom_id: 'pick', values: ['r'] });
  });
});

describe('the modal', () => {
  const MODAL = {
    interaction_id: 'int-1',
    channel_id: 'c1',
    custom_id: 'report',
    title: 'Report a problem',
    components: [
      {
        type: 'action_row',
        components: [{
          type: 'text_input', custom_id: 'what', label: 'What happened', style: 'short', required: true, min: 4,
        }],
      },
      {
        type: 'action_row',
        components: [{
          type: 'text_input', custom_id: 'more', label: 'Anything else', style: 'paragraph',
        }],
      },
    ],
  };

  async function openModal() {
    const store = fakeStore({ post: async () => ({ id: 'int-1', kind: 'component', local: false }) });
    show({ components: row({ type: 'button', style: 'primary', custom_id: 'go', label: 'Report' }) }, { store });
    fireEvent.click(screen.getByRole('button', { name: /Report/ }));
    await waitFor(() => expect(store.posted).toHaveLength(1));
    await act(async () => { store.emit('dispatch', { t: 'MODAL_OPEN', d: MODAL }); });
    await screen.findByText('Report a problem');
    return store;
  }

  it('says whose form it is and warns that Telium never asks for a password here', async () => {
    await openModal();
    expect(screen.getByText(/A form from/)).toBeTruthy();
    expect(screen.getByText('Ping Bot')).toBeTruthy();
    expect(screen.getByText(/never ask for your password/)).toBeTruthy();
  });

  it('refuses to submit a required field that is empty, and says so on the field', async () => {
    const store = await openModal();
    const before = store.posted.length;

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('This one is required.')).toBeTruthy();
    expect(store.posted).toHaveLength(before);

    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'ab' } });
    expect(await screen.findByText('At least 4 characters.')).toBeTruthy();
    expect(store.posted).toHaveLength(before);
  });

  it('submits the ids the application wrote, to the interaction it was opened for', async () => {
    const store = await openModal();
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: '  the buttons  ' } });
    fireEvent.change(screen.getByLabelText('Anything else'), { target: { value: 'twice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => expect(store.posted).toHaveLength(2));
    expect(store.posted[1].path).toBe('/_telium/v1/interactions/int-1/modal');
    expect(store.posted[1].body).toEqual({
      components: [
        { custom_id: 'what', value: 'the buttons' },
        { custom_id: 'more', value: 'twice' },
      ],
    });
  });
});

describe('a message only this reader can see', () => {
  it('says so, in words, above whatever the application wrote', async () => {
    const store = fakeStore();
    const surface = { id: 'c1', guildId: 'g1', avatarBase: HOME, memberOf: () => BOT };

    render(
      <StoreProvider store={store}>
        <ModalProvider>
          <EphemeralMessages surface={surface} channelId="c1" me="@me:guild.example" />
          <ModalHost />
        </ModalProvider>
      </StoreProvider>,
    );

    await act(async () => {
      handleInteractionFrame(store, 'EPHEMERAL_MESSAGE_CREATE', {
        id: 'e1', channel_id: 'c1', author: '@ping:guild.example', content: 'Only for you.',
      });
    });

    expect(await screen.findByText(/Only you can see this/)).toBeTruthy();
    expect(screen.getByText('Only for you.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    await waitFor(() => expect(screen.queryByText('Only for you.')).toBeNull());
  });

  it('presses on its own route, and is rewritten in place when the application edits it', async () => {
    const store = fakeStore({ post: async () => ({ id: 'int-9', kind: 'component', local: false }) });
    const surface = { id: 'c1', guildId: 'g1', avatarBase: HOME, memberOf: () => BOT };

    render(
      <StoreProvider store={store}>
        <ModalProvider>
          <EphemeralMessages surface={surface} channelId="c1" me="@me:guild.example" />
          <ModalHost />
        </ModalProvider>
      </StoreProvider>,
    );

    await act(async () => {
      handleInteractionFrame(store, 'EPHEMERAL_MESSAGE_CREATE', {
        id: 'e1',
        channel_id: 'c1',
        author: '@ping:guild.example',
        content: 'Are you sure?',
        components: row({ type: 'button', style: 'danger', custom_id: 'yes', label: 'Yes' }),
      });
    });

    fireEvent.click(await screen.findByRole('button', { name: /Yes/ }));
    await waitFor(() => expect(store.posted).toHaveLength(1));
    expect(store.posted[0].path).toBe('/_telium/v1/channels/c1/ephemeral/e1/interact');
    expect(store.posted[0].body).toEqual({ custom_id: 'yes' });

    await act(async () => {
      store.emit('dispatch', {
        t: 'EPHEMERAL_MESSAGE_UPDATE',
        d: { id: 'e1', channel_id: 'c1', ephemeral: true, content: 'Cancelled.', components: [] },
      });
    });

    expect(await screen.findByText('Cancelled.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Yes/ })).toBeNull();
  });
});
