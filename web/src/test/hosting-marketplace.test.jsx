import { describe, expect, it, vi } from 'vitest';
import { link, text } from '../lib/hosting.js';
import { act, screen, waitFor, within } from '@testing-library/react';
import { createFakeServer } from './fake-server.js';
import { signedInApp } from './harness.jsx';

const AURORA = {
  id: 'aurora',
  name: 'Aurora Guilds',
  description: 'Managed Telium servers, run in the EU.',
  base_url: 'https://guilds.aurora.example',
  signup_url: 'https://guilds.aurora.example/signup',
  terms_url: 'https://guilds.aurora.example/terms',
  privacy_url: 'https://guilds.aurora.example/privacy',
  contact: 'hello@aurora.example',
  regions: ['eu-west', 'eu-north'],
  plans: [{
    id: 'small',
    name: 'Small',
    price_minor: 500,
    currency: 'EUR',
    period: 'monthly',
    member_cap: 500,
    storage_bytes: 20 * 1024 ** 3,
    media_quota_bytes: null,
    notes: 'Daily backups included.',
  }],
  source: { kind: 'catalog', label: 'Community catalog', publisher: 'catalog.example' },
};

async function boot({ providers = [], enabled = providers.length > 0 } = {}) {
  const server = createFakeServer({
    hosting: { enabled, providers, guild_role: true, guided_handoff: true },
  });
  const { store, user } = await signedInApp(server);
  await act(async () => { await store.addServer('guilds.example'); });
  return { server, store, user };
}

const onscreen = (dialog) => dialog.querySelector('.stage__cur');

async function openCreate(user) {
  await user.click((await screen.findAllByTitle('Add a guild or server'))[0]);
  await user.click(await screen.findByRole('button', { name: /Create my own/ }));
  return step(/Host it here|Guild name/);
}

async function step(text) {
  return waitFor(() => {
    const cur = document.querySelector('.stage__cur');
    expect(cur?.textContent).toMatch(text);
    return cur;
  });
}

describe('the guild-hosting marketplace', () => {
  it('shows a provider’s price, limits and terms before anything is created', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const { server, user } = await boot({ providers: [AURORA] });
    const dialog = await openCreate(user);

    expect(await within(dialog).findByRole('button', { name: /Host it here/ })).toBeTruthy();
    const card = within(dialog).getByRole('button', { name: /Aurora Guilds/ });
    expect(card.textContent).toContain('From 5.00 EUR / month');
    expect(card.textContent).toContain('500 members');
    expect(card.textContent).toContain('20.0 GB storage');

    await user.click(card);
    const detail = await step(/Continue to Aurora Guilds/);
    expect(within(detail).getByText('Small')).toBeTruthy();
    expect(within(detail).getByText('5.00 EUR / month')).toBeTruthy();
    expect(within(detail).getByText(/500 members/)).toBeTruthy();
    expect(within(detail).getByText('eu-west')).toBeTruthy();
    expect(within(detail).getByText(/Daily backups included/)).toBeTruthy();
    expect(within(detail).getByText(/Community catalog/)).toBeTruthy();
    const terms = within(detail).getByRole('link', { name: 'Terms' });
    expect(terms.getAttribute('href')).toBe('https://guilds.aurora.example/terms');
    expect(terms.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(detail).getByRole('link', { name: 'Privacy' })).toBeTruthy();
    expect(within(detail).getByText(/Moving this guild/)).toBeTruthy();
    expect(within(detail).getByText(/takes no payment and holds no account/)).toBeTruthy();

    await user.click(within(detail).getByRole('button', { name: /Continue to Aurora Guilds/ }));
    expect(openSpy).toHaveBeenCalledWith(
      'https://guilds.aurora.example/signup', '_blank', 'noopener,noreferrer',
    );
    expect(server.state.guildCreates).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Continue to/ })).toBeNull());
    openSpy.mockRestore();
  });

  it('leaves the self-hosted path exactly as it was', async () => {
    const { server, user } = await boot({ providers: [AURORA] });
    const dialog = await openCreate(user);

    await user.click(await within(dialog).findByRole('button', { name: /Host it here/ }));
    const form = await step(/Create guild/);
    await user.type(await within(form).findByPlaceholderText('My guild'), 'Ours');
    expect(within(form).getByText(/Moving this guild/)).toBeTruthy();
    await user.click(within(form).getByRole('button', { name: 'Create guild' }));

    await waitFor(() => expect(server.state.guildCreates).toHaveLength(1));
    expect(server.state.guildCreates[0]).toMatchObject({ name: 'Ours' });
  });

  it('asks nothing extra when the operator lists nobody', async () => {
    const { server, user } = await boot({ providers: [] });
    const dialog = await openCreate(user);

    await within(dialog).findByPlaceholderText('My guild');
    expect(within(dialog).queryByRole('button', { name: /Host it here/ })).toBeNull();
    expect(server.state.guildCreates).toHaveLength(0);
  });

  it('renders a provider’s own text as text, and refuses links that are not https', async () => {
    const hostile = {
      ...AURORA,
      id: 'hostile',
      name: '<img src=x onerror="alert(1)">',
      description: 'Cheap‮gnitsoh‬ hosting.',
      terms_url: 'http://guilds.hostile.example/terms',
      base_url: 'javascript:alert(1)',            // eslint-disable-line no-script-url
      privacy_url: null,
    };
    const unreachable = { ...AURORA, id: 'plain', name: 'Plain HTTP Hosting', signup_url: 'http://plain.example/signup' };
    const { user } = await boot({ providers: [hostile, unreachable] });
    const dialog = await openCreate(user);

    expect(within(dialog).queryByRole('button', { name: /Plain HTTP Hosting/ })).toBeNull();
    const card = await within(dialog).findByRole('button', { name: /onerror/ });
    expect(card.querySelector('img')).toBeNull();
    expect(card.textContent).toContain('<img src=x onerror="alert(1)">');

    await user.click(card);
    const detail = onscreen(await screen.findByRole('dialog'));
    expect(detail.querySelector('img')).toBeNull();
    expect(within(detail).getByText(/Cheap.*hosting\./).textContent).not.toContain('‮');
    expect(within(detail).queryByRole('link', { name: 'Terms' })).toBeNull();
    expect(within(detail).queryByRole('link', { name: 'Website' })).toBeNull();
    expect(within(detail).queryAllByRole('link')).toHaveLength(0);
  });
});

describe('a provider does not get to steer what it is rendered as', () => {
  const RLO = String.fromCharCode(0x202e);
  const NUL = String.fromCharCode(0);
  const ISOLATE = String.fromCharCode(0x2066);

  it('strips the characters that let a name lie about itself', () => {
    expect(text(`Aurora${RLO}moc.live${NUL} Guilds`)).toBe('Auroramoc.live Guilds');
    expect(text(`${ISOLATE}Free${NUL}`)).toBe('Free');
    expect(text(`line${String.fromCharCode(10)}break`)).toBe('linebreak');
  });

  it('offers only a plain https address as a link', () => {
    expect(link('https://ok.example/signup')).toBe('https://ok.example/signup');
    expect(link('javascript:alert(1)')).toBe(null);
    expect(link('https://real.example@evil.example/signup')).toBe(null);
    expect(link(`https://ok.example/${RLO}`)).not.toContain(RLO);
  });
});
