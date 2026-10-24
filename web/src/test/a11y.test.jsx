import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useModal } from '../hooks/modalContext.js';
import { ConfirmDialog, PromptDialog, ModalShell } from '../components/Modal.jsx';
import {
  ActionList, ActionRow, Badge, Banner, Button, Checkbox, ChoiceCard, ChoiceList,
  Crumb, DataTable, Dots, EmptyState, Field, Flow, IconButton, Loading,
  Notice, PasswordInput, Pill, Presence, PRESENCE_STATES, ProgressBar, ReactionPill,
  SearchField, Select, Switch, Tabs, TextArea, TextInput, Way, Ways,
} from '../components/index.js';
import { MenuButton, MenuItem, MenuSection, MenuSeparator, MenuSlider } from '../components/Menu.jsx';
import { SwatchRow } from '../components/SwatchRow.jsx';
import { Tooltip } from '../components/Tooltip.jsx';
import { TrashIcon, UserIcon } from '../components/icons.jsx';
import { expectNoViolations } from './a11y.js';
import { GUILD_DOMAIN, ME, mount, signedInStore } from './harness.jsx';

import { RoleChips } from '../views/profile/RoleChips.jsx';
import { AddGuildDialog } from '../views/dialogs/AddGuildDialog.jsx';
import { ConversationDialog } from '../views/dialogs/ConversationDialog.jsx';
import { CreateCategoryDialog } from '../views/dialogs/CreateCategoryDialog.jsx';
import { CreateChannelDialog } from '../views/dialogs/CreateChannelDialog.jsx';
import { CustomStatusDialog } from '../views/dialogs/CustomStatusDialog.jsx';
import { EditChannelDialog } from '../views/dialogs/EditChannelDialog.jsx';
import { EmojiPickerDialog } from '../views/dialogs/EmojiPickerDialog.jsx';
import { ExternalLinkDialog } from '../views/dialogs/ExternalLinkDialog.jsx';
import { FollowChannelDialog } from '../views/dialogs/FollowChannelDialog.jsx';
import { GifPickerDialog } from '../views/dialogs/GifPickerDialog.jsx';
import { InviteDialog } from '../views/dialogs/InviteDialog.jsx';
import { MessageRequestsDialog } from '../views/dialogs/MessageRequestsDialog.jsx';
import { NewConversationDialog } from '../views/dialogs/NewConversationDialog.jsx';
import { NewPostDialog } from '../views/dialogs/NewPostDialog.jsx';
import { PinsButton, PinsDialog } from '../views/dialogs/PinsDialog.jsx';
import { PromoteDialog } from '../views/dialogs/PromoteDialog.jsx';
import { QuickSwitcher } from '../views/dialogs/QuickSwitcher.jsx';
import { ReportDialog } from '../views/dialogs/ReportDialog.jsx';
import { ScreeningDialog } from '../views/dialogs/ScreeningDialog.jsx';
import { ScreenShareDialog } from '../views/dialogs/ScreenShareDialog.jsx';
import { SearchDialog } from '../views/dialogs/SearchDialog.jsx';
import { ThreadsDialog } from '../views/dialogs/ThreadsDialog.jsx';
import { VerifyDialog } from '../views/dialogs/VerifyDialog.jsx';
import { WatchTogetherDialog } from '../views/dialogs/WatchTogetherDialog.jsx';
import { StepUpDialog } from '../views/control-plane/StepUp.jsx';
import { FinalizeDialog } from '../views/control-plane/ContinuityOps.jsx';
import { ControlPlaneContext } from '../views/control-plane/context.js';
import { AccountsPane } from '../views/control-plane/AccountsPane.jsx';
import { ContinuityPane } from '../views/control-plane/ContinuityPane.jsx';
import { GuildsPane } from '../views/control-plane/GuildsPane.jsx';
import { NetworkPrivacyPane } from '../views/user-settings/NetworkPrivacyPane.jsx';
import { PublicProfileLanding } from '../views/PublicProfileLanding.jsx';

const noop = () => {};

const COMPONENTS = [
  ['Button', <Button>Save</Button>],
  ['Button, loading', <Button loading>Save</Button>],
  ['IconButton', <IconButton title="Delete message" icon={TrashIcon} />],
  ['TextInput, hint + invalid', <TextInput label="Email" hint="Shown to nobody." required aria-invalid="true" value="x" onChange={noop} />],
  ['PasswordInput', <PasswordInput value="" onChange={noop} />],
  ['TextArea', <TextArea label="About" value="" onChange={noop} />],
  ['SearchField', <SearchField label="Search" value="" onChange={noop} />],
  ['Select', <Select label="Region" value="eu" onChange={noop} options={[['eu', 'Europe'], ['us', 'America']]} />],
  ['Checkbox, with hint', <Checkbox label="Send me mail" hint="Monthly." checked={false} onChange={noop} />],
  ['Switch, with hint', <Switch label="Public profile link" hint="Anyone with the URL." checked={false} onChange={noop} />],
  ['Switch, hidden label', <Switch label="Manage roles" hideLabel checked={false} onChange={noop} />],
  ['Field, bare control', <Field label="Colour" hint="Any hex."><input type="text" defaultValue="#4B2E83" /></Field>],
  ['Notice, danger', <Notice tone="danger">That password is wrong.</Notice>],
  ['Pill', <Pill tone="danger">suspended</Pill>],
  ['EmptyState', <EmptyState title="No invites">Nobody has made one yet.</EmptyState>],
  ['Loading', <Loading label="Fetching members" />],
  ['ProgressBar', <ProgressBar value={42} label="Upload progress" />],
  ...PRESENCE_STATES.map((status) => [`Presence, ${status}`, <Presence status={status} />]),
  ['Badge', <Badge count={7} />],
  ['Banner', <Banner tone="danger" role="alert">Your connection is down.</Banner>],
  ['ReactionPill', <ReactionPill emoji="🎉" count={3} reacted reactors={['@ada:home.example']} onClick={noop} />],
  ['ActionList', (
    <ActionList>
      <ActionRow icon={UserIcon} label="Add a friend" description="By their handle." onClick={noop} />
      <ActionRow icon={TrashIcon} label="Leave" danger onClick={noop} />
    </ActionList>
  )],
  ['ChoiceList', (
    <ChoiceList value="a" onChange={noop} aria-label="Theme">
      <ChoiceCard value="a" label="Light" description="A pale page." />
      <ChoiceCard value="b" label="Dark" description="A deep one." />
    </ChoiceList>
  )],
  ['DataTable', (
    <DataTable
      label="Devices"
      columns={[{ key: 'name', header: 'Name', render: (r) => r.name }]}
      rows={[{ name: 'Laptop' }, { name: 'Phone' }]}
      rowKey={(r) => r.name}
    />
  )],
  ['SwatchRow', <SwatchRow label="Role colour" value="#4B2E83" options={[['Amethyst', '#4B2E83'], ['Lilac', '#B68DF0']]} onChange={noop} />],
  ['Tabs', <Tabs value="all" options={[['all', 'All'], ['online', 'Online']]} onChange={noop} aria-label="Filter" />],
  ['Flow', (
    <Flow step="pick">
      <Crumb label="Back" onClick={noop} />
      <Dots steps={['pick', 'name', 'done']} at="pick" />
      <Ways><Way icon={UserIcon} name="Join a server" description="With an invite." onClick={noop} /></Ways>
    </Flow>
  )],
];

describe('reusable components', () => {
  for (const [name, element] of COMPONENTS) {
    it(`${name} has no violations`, async () => {
      await expectNoViolations(render(element), name);
    });
  }

  const openMenu = async (content) => {
    const user = userEvent.setup();
    const view = render(<MenuButton label="Channel options" content={content}><span aria-hidden="true">...</span></MenuButton>);
    await user.click(view.getByRole('button', { name: 'Channel options' }));
    await view.findByRole('menu');
    return view;
  };

  it('an open dropdown menu has no violations', async () => {
    const view = await openMenu(
      <>
        <MenuSection title="This channel"><MenuItem icon={UserIcon}>Invite people</MenuItem></MenuSection>
        <MenuSeparator />
        <MenuItem icon={TrashIcon} tone="danger">Delete</MenuItem>
      </>,
    );
    await expectNoViolations(view, 'an open dropdown menu');
  });

  it('a menu with a slider has no violations beyond menu-role nesting', async () => {
    const view = await openMenu(
      <MenuSection title="Ada">
        <MenuSlider label="Volume" value={50} onChange={noop} />
        <MenuItem icon={TrashIcon} tone="danger">Remove</MenuItem>
      </MenuSection>,
    );
    await expectNoViolations(view, 'a menu with a slider', { rules: { 'aria-required-children': { enabled: false } } });
  });

  it('an open tooltip has no violations', async () => {
    const user = userEvent.setup();
    const view = render(<Tooltip label="Pinned messages" delay={0}><button type="button">Pins</button></Tooltip>);
    await user.hover(view.getByRole('button', { name: 'Pins' }));
    await expectNoViolations(view, 'an open tooltip');
  });
});

const BOB = '@bob:home.example';
const CAROL = '@carol:elsewhere.example';
const OWNER = '18446744073709551615';
const ch = (id, name, over = {}) => ({ id, name, type: 'text', position: 0, parent_id: null, ...over });

const GUILD = {
  id: 'g1',
  name: 'Telium',
  domain: GUILD_DOMAIN,
  channels: [
    ch('c-general', 'general', { position: 0 }),
    ch('c-cat', 'Text channels', { type: 'category', position: 1 }),
    ch('c-party', 'party', { position: 2, parent_id: 'c-cat' }),
    ch('c-news', 'news', { type: 'announcement', position: 3 }),
    ch('c-forum', 'forum', { type: 'forum', position: 4, available_tags: [{ id: 't1', name: 'Bug' }] }),
  ],
  roles: [{ id: 'g1', name: '@everyone', permissions: '0' }],
  me: { user_id: ME, roles: [], permissions: OWNER },
};
const dm = (id, peer, over = {}) => ({
  id, kind: 'dm', sequencer: 'home.example', epoch: 1, last_seq: 0,
  members: [ME, peer].map((user_id) => ({ user_id, state: 'joined' })), ...over,
});
const CONVO = dm('dm1', BOB);
const MESSAGE = { id: 'm1', channel_id: 'c-general', author: BOB, content: 'Read this', created_at: Date.now() };

function furnished(extra = []) {
  return signedInStore({
    guilds: [GUILD],
    conversations: [CONVO, ...extra],
    friends: [{ user_id: BOB, state: 'accepted', display_name: 'Bob' }],
    route: { guildId: 'g1', channelId: 'c-general' },
  });
}
const withARequest = () => furnished([dm('dm-req', CAROL, { request_state: 'pending' })]);

function Opener({ render: body }) {
  const modal = useModal();
  return <button type="button" onClick={() => modal.open(body)}>Open it</button>;
}

async function openDialog(store, body) {
  const view = mount(<Opener render={body} />, store);
  const trigger = screen.getByRole('button', { name: 'Open it' });
  await view.user.click(trigger);
  const dialog = await screen.findByRole('dialog');
  return { ...view, trigger, dialog };
}

const DIALOGS = [
  ['Add a guild', (close) => <AddGuildDialog close={close} />],
  ['Conversation settings', (close) => <ConversationDialog convo={CONVO} close={close} refresh={noop} />],
  ['Create category', (close, s) => <CreateCategoryDialog guild={s.guilds.get('g1')} close={close} />],
  ['Create channel', (close, s) => <CreateChannelDialog guild={s.guilds.get('g1')} close={close} parentId="c-cat" />],
  ['Custom status', (close) => <CustomStatusDialog close={close} />],
  ['Edit channel', (close, s) => <EditChannelDialog channel={s.channels.get('c-general')} close={close} />],
  ['Emoji picker', (close) => <EmojiPickerDialog guildId="g1" close={close} onPick={noop} />],
  ['External link', (close, s) => (
    <ExternalLinkDialog store={s} destination={{ href: 'https://example.com/a', host: 'example.com' }} onOpen={noop} close={close} />
  )],
  ['Follow channel', (close, s) => <FollowChannelDialog channel={s.channels.get('c-news')} close={close} />],
  ['GIF picker', (close) => <GifPickerDialog close={close} onPick={noop} />],
  ['Invite people', (close, s) => <InviteDialog guild={s.guilds.get('g1')} close={close} />],
  ['New conversation', (close) => <NewConversationDialog close={close} />],
  ['New post', (close, s) => <NewPostDialog channel={s.channels.get('c-forum')} close={close} onCreated={noop} />],
  ['Pinned messages', (close) => <PinsDialog channelId="c-general" close={close} />],
  ['Promote a conversation', (close) => <PromoteDialog convo={CONVO} close={close} />],
  ['Quick switcher', (close) => <QuickSwitcher close={close} onGone={noop} />],
  ['Report a message', (close) => <ReportDialog msg={MESSAGE} close={close} />],
  ['Screening questions', (close) => (
    <ScreeningDialog domain={GUILD_DOMAIN} resp={{ guild_id: 'g1', screening: { questions: ['Why join?'] } }} close={close} />
  )],
  ['Share your screen', (close) => <ScreenShareDialog close={close} onStart={noop} />],
  ['Search', (close) => <SearchDialog guildId="g1" close={close} />],
  ['Threads', (close) => <ThreadsDialog channelId="c-general" close={close} />],
  ['Verify a person', (close) => <VerifyDialog userId={BOB} close={close} />],
  ['Watch together', (close) => <WatchTogetherDialog close={close} allowed={['youtube', 'file']} sealed={false} onStart={noop} />],
  ['Confirm', (close) => <ConfirmDialog title="Delete #party" body="This cannot be undone." danger onConfirm={noop} close={close} />],
  ['Prompt', (close) => <PromptDialog title="Rename" label="Channel name" value="party" onSubmit={noop} close={close} />],
  ['Message requests', (close) => <MessageRequestsDialog close={close} />, withARequest],
  ['Step up', (close) => <StepUpDialog onDone={noop} close={close} />],
  ['Shut this server down', (close) => <FinalizeDialog serverName="home.example" onFinalize={noop} close={close} />],
];

describe('every dialog', () => {
  for (const [name, body, makeStore = furnished] of DIALOGS) {
    it(`${name} is reachable, escapable and clean`, async () => {
      const store = makeStore();
      const { user, trigger, dialog } = await openDialog(store, (close) => body(close, store));
      expect(dialog.contains(document.activeElement)).toBe(true);
      await expectNoViolations({ baseElement: document.body }, `the ${name} dialog`);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    });
  }

  it('a select inside a dialog takes the first Escape and leaves the dialog open', async () => {
    const { user } = await openDialog(furnished(), () => (
      <ModalShell title="Channel settings">
        <Select label="Slow mode" options={[['0', 'Off'], ['5', '5 seconds']]} value="0" onChange={noop} />
      </ModalShell>
    ));
    await user.click(screen.getByRole('combobox'));
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(screen.queryByRole('dialog')).not.toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('hand-placed panels', () => {
  it('the pins panel takes focus from the pin and hands it back', async () => {
    const view = mount(<PinsButton channelId="c-general" />, furnished());
    const pin = screen.getByRole('button', { name: 'Pinned messages' });
    await view.user.click(pin);
    const panel = await screen.findByRole('dialog', { name: 'Pinned messages' });
    expect(panel.contains(document.activeElement)).toBe(true);
    await view.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pinned messages' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(pin));
  });

  it('the role picker takes focus from the plus and hands it back', async () => {
    const store = furnished();
    const view = mount(
      <RoleChips store={store} guildId="g1" displayName="Bob" roles={[]} mayManage busy={null} onToggle={noop} />,
      store,
    );
    const plus = screen.getByRole('button', { name: 'Add a role to Bob' });
    expect(plus.getAttribute('aria-expanded')).toBe('false');
    expect(plus.getAttribute('aria-haspopup')).toBe('dialog');
    await view.user.click(plus);
    const panel = await screen.findByRole('dialog', { name: 'Add a role' });
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(plus.getAttribute('aria-expanded')).toBe('true');
    await view.user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(plus));
  });
});

describe('screens', () => {
  it('the network privacy pane is clean', async () => {
    await expectNoViolations(mount(<NetworkPrivacyPane />, signedInStore({})), 'the network privacy pane');
  });

  it('the public profile page is clean, loading and unreachable', async () => {
    const rules = { rules: { region: { enabled: true }, 'page-has-heading-one': { enabled: true } } };
    const loading = mount(<PublicProfileLanding userId="@carol:elsewhere.example" sessionReady />, signedInStore({}));
    await expectNoViolations(loading, 'the public profile page, loading', rules);
    loading.unmount();
    const bad = mount(<PublicProfileLanding userId="not-an-address" sessionReady />, signedInStore({}));
    await screen.findByText(/not a valid Telium user address/);
    await expectNoViolations(bad, 'the public profile page, unreachable', rules);
  });

  function plane(ui, overrides) {
    const home = new Proxy({ ...overrides }, { get: (t, k) => (k in t ? t[k] : async () => ({})) });
    const store = signedInStore({ me: { admin: true } });
    store.home = home;
    const idle = { data: null, error: null, at: Date.now(), loading: false, reload: noop };
    const stepUp = { elevated: true, expiresAt: Date.now() + 300_000, isElevated: () => true, elevate: async () => true, drop: noop, reload: noop };
    return mount(
      <ControlPlaneContext.Provider value={{ home, metrics: idle, status: idle, stepUp, pollMs: 15_000 }}>{ui}</ControlPlaneContext.Provider>,
      store,
    );
  }

  it('the accounts pane is clean with admin, suspended and off rows', async () => {
    const view = plane(<AccountsPane />, {
      adminAccounts: async () => ({
        total: 3,
        accounts: [
          { user_id: '@ada:home.example', localpart: 'ada', display_name: 'Ada', admin: true },
          { user_id: '@bo:home.example', localpart: 'bo', display_name: 'Bo', suspended_at: Date.now(), deactivated: true },
          { user_id: '@cy:home.example', localpart: 'cy', display_name: 'Cy', deactivated: true },
        ],
      }),
    });
    await screen.findByText('@bo:home.example');
    await expectNoViolations(view, 'the accounts pane');
  });

  it('the guilds pane is clean with tombstoned rows', async () => {
    const view = plane(<GuildsPane />, {
      adminGuilds: async () => ({
        total: 3,
        guilds: [
          { id: 'g1', name: 'Telium', alias: '#telium:home.example', members: 12, channels: 4, messages: 900 },
          { id: 'g2', name: 'Moved', moved_to: 'elsewhere.example', members: 3, channels: 1, messages: 10 },
          { id: 'g3', name: 'Gone', gone: true, members: 0, channels: 0, messages: 0 },
        ],
      }),
    });
    await screen.findByText('Telium');
    await expectNoViolations(view, 'the guilds pane');
  });

  it('the continuity pane is clean while read-only', async () => {
    const view = plane(<ContinuityPane />, {
      adminContinuity: async () => ({
        read_only: true,
        shut_down: false,
        standbys: [{ id: 's1', domain: 'standby.example', seen_at: Date.now() }],
        mirrors: [],
        tombstones: [{ kind: 'moved', count: 2 }],
      }),
    });
    await screen.findByText(/no longer the authority/);
    await expectNoViolations(view, 'the continuity pane');
  });
});
