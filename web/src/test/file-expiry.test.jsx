import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { defaultExpiry, describeLimit, expiryOptions, narrowestLimit } from '../lib/upload.js';
import { createFakeServer } from './fake-server.js';
import { signedInApp } from './harness.jsx';

describe('expiry option arithmetic', () => {
  it('takes the narrowest cap, treating zero and absent as no cap', () => {
    expect(narrowestLimit(null, null)).toBeNull();
    expect(narrowestLimit(3600, null, 60)).toBe(60);
    expect(narrowestLimit(0, 3600)).toBe(3600);
  });

  it('offers only what fits under the cap, plus the cap itself when exact', () => {
    const hour = 60 * 60;
    expect(expiryOptions(null).map((o) => o.label))
      .toEqual(['1 hour', '1 day', '1 week', '30 days', 'Never']);
    const twoDays = 2 * 24 * 60 * 60;
    expect(expiryOptions(twoDays).map((o) => o.label)).toContain('2 days');
    expect(expiryOptions(twoDays).some((o) => o.secs === null)).toBe(false);
    expect(expiryOptions(hour).map((o) => o.secs)).toContain(hour);
  });

  it('defaults to 30 days when allowed, else to the cap itself', () => {
    const month = 30 * 24 * 60 * 60;
    expect(defaultExpiry(expiryOptions(null))).toBe(month);
    expect(defaultExpiry(expiryOptions(60 * 60))).toBe(60 * 60);
    expect(defaultExpiry(expiryOptions(2 * 24 * 60 * 60))).toBe(2 * 24 * 60 * 60);
  });

  it('speaks human units for an exact cap', () => {
    expect(describeLimit(900)).toBe('15 minutes');
    expect(describeLimit(24 * 60 * 60)).toBe('1 day');
  });
});

async function boot({ guildExpiry = null } = {}) {
  const server = createFakeServer();
  server.state.guild.media_expiry_limit_secs = guildExpiry;
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  await user.click(await screen.findByTitle('Telium on guilds.example'));
  await user.click(await screen.findByRole('button', { name: 'general' }));
  return { server, store, user };
}

describe('the staged-file tray', () => {
  it('refuses a file the origin caps before a byte is sent', async () => {
    const server = createFakeServer();
    server.state.serverMediaMaxFileBytes = 4;
    const { user } = await (async () => {
      const { store, user } = await signedInApp(server);
      await act(async () => { await store.addServer('guilds.example'); });
      await user.click(await screen.findByTitle('Telium on guilds.example'));
      await user.click(await screen.findByRole('button', { name: 'general' }));
      return { store, user };
    })();

    const before = server.state.mediaUploads.length;
    await user.upload(filePicker(), new File(['way too many bytes'], 'big.txt', { type: 'text/plain' }));
    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(alerts.some((el) => /Too large/.test(el.textContent))).toBe(true);
    });
    expect(server.state.mediaUploads.length).toBe(before);
  });


  const filePicker = () => document.querySelector('input[type="file"]');

  const openExpiryMenu = async (user) => {
    await user.click(screen.getByRole('button', { name: 'Keep files for' }));
    return screen.findByRole('menu');
  };

  const notesFile = () => new File(['hello'], 'notes.txt', { type: 'text/plain' });

  const browse = async (user, server, file = notesFile()) => {
    const before = server.state.mediaUploads.length;
    await user.upload(filePicker(), file);
    await waitFor(() => expect(server.state.mediaUploads.length).toBe(before + 1));
    return server.state.mediaUploads[before];
  };

  it('attaches straight from the paperclip, with no picker parked in the strip', async () => {
    const { user } = await boot();
    expect(screen.queryByRole('button', { name: 'Keep files for' })).toBeNull();

    const picker = filePicker();
    const opened = vi.spyOn(picker, 'click');
    await user.click(screen.getByTitle('Attach a file'));
    expect(opened).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    opened.mockRestore();
  });

  it('offers the whole ladder when no room narrows it', async () => {
    const { server, user } = await boot();
    await browse(user, server);

    const menu = await openExpiryMenu(user);
    expect(within(menu).getByRole('menuitem', { name: 'Keeps forever' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Expires in 1 hour' })).toBeTruthy();
  });

  it('narrows to the guild cap, and says the room clamped it', async () => {
    const { server, user } = await boot({ guildExpiry: 60 * 60 });
    await browse(user, server);

    const menu = await openExpiryMenu(user);
    expect(within(menu).getByRole('menuitem', { name: 'Expires in 1 hour' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Keeps forever' })).toBeNull();
    expect(within(menu).getByText(/deleted after at most an hour/)).toBeTruthy();
  });

  it('stages a card and sends the 30-day default without anybody opening the menu', async () => {
    const { server, user } = await boot();
    const up = await browse(user, server);

    expect(up.ttl).toBe(30 * 24 * 60 * 60);
    expect(up.channel_id).toBe('c1');
    expect(up.expires_at).toBeGreaterThan(Date.now());
    expect(screen.getByText('notes.txt')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep files for' }).textContent)
      .toContain('Expires in 30 days');
  });

  it('takes a file dropped onto the conversation like a browsed one', async () => {
    const { server } = await boot();
    const file = notesFile();
    const dataTransfer = { files: [file], types: ['Files'], dropEffect: 'none' };

    expect(fireEvent.dragOver(document.body, { dataTransfer })).toBe(false);
    expect(fireEvent.drop(document.body, { dataTransfer })).toBe(false);

    await waitFor(() => expect(server.state.mediaUploads.length).toBe(1));
    expect(server.state.mediaUploads[0].ttl).toBe(30 * 24 * 60 * 60);
    expect(await screen.findByText('notes.txt')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep files for' })).toBeTruthy();
  });

  it('sends the chosen lifetime with the upload, and the origin answers', async () => {
    const { server, user } = await boot();
    await browse(user, server);
    await user.click(within(await openExpiryMenu(user))
      .getByRole('menuitem', { name: 'Expires in 1 hour' }));

    const second = await browse(user, server, new File(['x'], 'later.txt', { type: 'text/plain' }));
    expect(second.ttl).toBe(60 * 60);
    expect(second.filename).toBe('later.txt');
  });

  it('puts every staged file in flight instead of queueing them', async () => {
    const { server, user } = await boot();
    let release;
    server.state.uploadGate = new Promise((resolve) => { release = resolve; });

    await user.upload(document.querySelector('input[type="file"]'), [
      new File(['a'], 'a.txt', { type: 'text/plain' }),
      new File(['bb'], 'b.txt', { type: 'text/plain' }),
      new File(['ccc'], 'c.txt', { type: 'text/plain' }),
    ]);
    await waitFor(() => expect(server.state.uploadSeen).toBe(3));
    expect(server.state.mediaUploads.length).toBe(0);

    release();
    await waitFor(() => expect(server.state.mediaUploads.length).toBe(3));
  });

  it('keeps a failed upload as a card with its reason, and Retry lands it', async () => {
    const { server, user } = await boot();
    server.state.failNextUpload = true;
    await user.upload(document.querySelector('input[type="file"]'), notesFile());

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(alerts.some((el) => el.textContent.includes('pretending to be broken'))).toBe(true);
    });
    expect(server.state.mediaUploads.length).toBe(0);

    server.state.failNextUpload = false;
    await user.click(screen.getByTitle('Retry upload'));
    await waitFor(() => expect(server.state.mediaUploads.length).toBe(1));
    await waitFor(() => {
      const alerts = screen.queryAllByRole('alert');
      expect(alerts.every((el) => !el.textContent.includes('pretending to be broken'))).toBe(true);
    });
  });

  it('offers Delete file on your own message and takes the file off the origin', async () => {
    const { server, user } = await boot();
    await browse(user, server);
    await waitFor(() => expect(server.state.storedMedia.size).toBe(1));
    await user.click(screen.getByTitle('Send'));
    await waitFor(() => expect(screen.getAllByText('notes.txt').length).toBeGreaterThan(0));

    const inTimeline = screen.getAllByText('notes.txt').at(-1);
    fireEvent.contextMenu(inTimeline);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete file: notes.txt' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Delete file' }));
    await waitFor(() => expect(server.state.storedMedia.size).toBe(0));
  });
});
