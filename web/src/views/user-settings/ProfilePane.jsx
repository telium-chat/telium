import { useRef, useState } from 'react';
import { AnimatedImage } from '../../components/AnimatedImage.jsx';
import { useAsync, useStore } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { copyToClipboard } from '../../lib/clipboard.js';
import { uploadMedia, profileRef } from '../../lib/upload.js';
import { downscaleToFit } from '../../lib/image.js';
import { publicProfileLink } from '../PublicProfileLanding.jsx';
import { themeOf } from '../../lib/util.js';
import { useImageCrop } from '../dialogs/CropImageDialog.jsx';
import { useUnsavedChanges } from '../../components/SettingsLayout.jsx';
import { useAutosize } from '../chat/MarkdownInk.jsx';
import {
  Async, Avatar, BioText, Button, EmojiText, Field, Hint, ImageIcon, MenuButton,
  MenuItem, MoreIcon, SpinnerIcon, SwatchRow, Switch, TextArea, TextInput, TrashIcon,
} from '../../components/index.js';

const NAME_MAX = 64;
const PRONOUNS_MAX = 40;

const COUNT_FROM = 80;

const ACCENTS = [
  ['Lilac', '#a98bff'],
  ['Violet', '#7c5cff'],
  ['Indigo', '#5865f2'],
  ['Azure', '#3e8ff0'],
  ['Teal', '#33c2c2'],
  ['Mint', '#3fbf8f'],
  ['Amber', '#e0a03a'],
  ['Coral', '#e8705b'],
  ['Rose', '#e0558c'],
  ['Magenta', '#b44cd9'],
  ['Slate', '#7a8194'],
];

export function ProfilePane() {
  const store = useStore();
  const state = useAsync(() => store.home.whoami(), []);
  return <Async state={state}>{(me) => <Editor me={me} />}</Async>;
}

function Editor({ me }) {
  const store = useStore();
  const cropImage = useImageCrop();
  const [saved, setSaved] = useState(() => baseline(me.profile));
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(null);
  const avatarFile = useRef(null);
  const bannerFile = useRef(null);
  const bioRef = useRef(null);

  useAutosize(bioRef);

  const bioMax = store.bioLimit();
  const bioLen = [...draft.bio].length;
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const changed = (key) => draft[key] !== saved[key];
  const dirty = Object.keys(saved).some(changed);
  const nameError = !draft.displayName.trim() || draft.displayName.length > NAME_MAX;
  const bioError = bioLen > bioMax;

  useUnsavedChanges(dirty && !busy);

  const pick = async (kind, picked) => {
    if (!picked) return;
    const cropped = await cropImage(picked, kind);
    if (!cropped) return;
    // The origin refuses profile assets past its cap with "crop or downscale
    // it first"; do the downscaling here so the sentence stays unread.
    const cap = store.caps.get(store.session?.home?.domain)?.media?.max_profile_asset_bytes ?? null;
    const file = await downscaleToFit(cropped, cap);
    setUploading(kind);
    try {
      const media = await uploadMedia(store.home, file, 'profile');
      set({ [kind === 'avatar' ? 'avatarRef' : 'bannerRef']: profileRef(media) });
    } catch (e) { reportError(e, 'Upload failed'); }
    finally { setUploading(null); }
  };

  const save = async () => {
    setBusy(true);
    try {
      await store.home.patchProfile({
        display_name: draft.displayName.trim(),
        pronouns: draft.pronouns.trim(),
        bio: draft.bio,
        accent_color: parseInt(draft.accent.slice(1), 16),
        theme_colors: draft.themeTop
          ? [parseInt(draft.themeTop.slice(1), 16), parseInt(draft.themeBottom.slice(1), 16)]
          : null,
        avatar_ref: draft.avatarRef,
        banner_ref: draft.bannerRef,
        public_page_enabled: draft.publicPageEnabled,
        public_status_enabled: draft.publicStatusEnabled,
        public_activity_enabled: draft.publicActivityEnabled,
      });
      store.me = await store.home.whoami();
      store.emit('me', store.me);
      const landed = {
        ...draft,
        displayName: draft.displayName.trim(),
        pronouns: draft.pronouns.trim(),
      };
      setSaved(landed);
      setDraft(landed);
      toast('Profile saved.');
    } catch (e) { reportError(e, 'Could not save profile'); }
    finally { setBusy(false); }
  };

  const media = (kind) => {
    const key = kind === 'avatar' ? 'avatarRef' : 'bannerRef';
    const input = kind === 'avatar' ? avatarFile : bannerFile;
    return (
      <MenuButton
        label={`Change ${kind}`}
        placement="bottom end"
        className={kind === 'avatar' ? 'profile-edit__chip' : 'profile-edit__banner-chip'}
        content={(
          <>
            <MenuItem icon={ImageIcon} onAction={() => input.current?.click()}>
              {draft[key] ? `Replace ${kind}` : `Upload ${kind}`}
            </MenuItem>
            {draft[key] ? (
              <MenuItem icon={TrashIcon} tone="danger" onAction={() => set({ [key]: null })}>
                Remove
              </MenuItem>
            ) : null}
          </>
        )}
      >
        {uploading === kind
          ? <SpinnerIcon className="size-3.5 animate-spin" />
          : <MoreIcon className="size-3.5" />}
      </MenuButton>
    );
  };

  return (
    <>
      <input
        ref={avatarFile}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose a new avatar image"
        onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; pick('avatar', f); }}
      />
      <input
        ref={bannerFile}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose a new banner image"
        onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; pick('banner', f); }}
      />

      <div className="profile-edit">
        <div className="profile-edit__aside">
          <div className="eyebrow pb-1.5">How people see you</div>
          <Preview
            me={me}
            draft={draft}
            base={store.home.base}
            avatarMenu={media('avatar')}
            bannerMenu={media('banner')}
          />
          <p className="pt-2 text-xs text-muted">
            Nicknames are set per guild and are not this.
          </p>
        </div>

        <div className="profile-edit__form">
          <div className="flex flex-col gap-4">
            <Field
              label="Display name"
              hint={draft.displayName.length > NAME_MAX ? `${NAME_MAX} characters at most.` : undefined}
            >
              <TextInput
                value={draft.displayName}
                maxLength={NAME_MAX + 20}
                onChange={(e) => set({ displayName: e.target.value })}
              />
            </Field>

            <Field label="Pronouns">
              <TextInput
                value={draft.pronouns}
                placeholder="optional"
                maxLength={PRONOUNS_MAX}
                onChange={(e) => set({ pronouns: e.target.value })}
              />
            </Field>

            <div>
              <Field
                label="About"
                hint="**bold**, *italic*, `code` and a link typed out in full."
              >
                <TextArea
                  inputRef={bioRef}
                  rows={1}
                  value={draft.bio}
                  placeholder="A line or two."
                  className="profile-edit__about resize-none"
                  onChange={(e) => {
                    const next = [...e.target.value];
                    set({ bio: next.length > bioMax ? next.slice(0, bioMax).join('') : e.target.value });
                  }}
                />
              </Field>
              {bioLen > bioMax - COUNT_FROM ? (
                <div className="profile-edit__count" data-over={bioError || undefined}>
                  {bioLen} / {bioMax}
                </div>
              ) : null}
            </div>

            <Field label="Accent" hint="Behind your name, wherever your card is drawn.">
              <SwatchRow
                label="Accent colour"
                options={ACCENTS}
                value={draft.accent}
                onChange={(hex) => set({ accent: hex })}
              />
            </Field>

            <Field label="Theme" hint="The border and background of your card, from top to bottom.">
              <div className="flex flex-col gap-2">
                <SwatchRow
                  label="Theme top colour"
                  options={ACCENTS}
                  none="No theme"
                  fallback={draft.accent}
                  value={draft.themeTop}
                  onChange={(hex) => set(hex
                    ? { themeTop: hex, themeBottom: draft.themeBottom || hex }
                    : { themeTop: '', themeBottom: '' })}
                />
                <SwatchRow
                  label="Theme bottom colour"
                  options={ACCENTS}
                  none="No theme"
                  fallback={draft.accent}
                  value={draft.themeBottom}
                  onChange={(hex) => set(hex
                    ? { themeBottom: hex, themeTop: draft.themeTop || hex }
                    : { themeTop: '', themeBottom: '' })}
                />
              </div>
            </Field>

            <div className="pt-2">
              <div className="eyebrow pb-1.5">Public profile link</div>
              <div className="divide-y divide-border panel px-3">
                <Switch
                  label="Enable public profile link"
                  hint="Allow anyone with your profile URL to view your public profile without signing in."
                  checked={draft.publicPageEnabled}
                  onChange={(next) => set({ publicPageEnabled: Boolean(next) })}
                />
                <Switch
                  label="Show status"
                  hint="Publish your Online, Idle, Do Not Disturb or Offline state and your custom status text. Anyone with your link can refresh it to see when you are at your computer."
                  checked={draft.publicStatusEnabled}
                  onChange={(next) => set({ publicStatusEnabled: Boolean(next) })}
                />
                <Switch
                  label="Show activity"
                  hint="Publish what you are doing to anyone with your link, including the details whatever app is reporting it chooses to send. Follows your activity-category settings."
                  checked={draft.publicActivityEnabled}
                  onChange={(next) => set({ publicActivityEnabled: Boolean(next) })}
                />
              </div>
              <div className="mt-3">
                <Button
                  variant="secondary"
                  onClick={() => copyToClipboard(publicProfileLink(me.user_id), 'Profile link')}
                >
                  Copy public profile link
                </Button>
              </div>
              <Hint>
                Public profile links are always excluded from search-engine indexing.
                Friend requests and message requests still use your normal account-wide rules.
              </Hint>
            </div>
          </div>
        </div>
      </div>

      {dirty ? (
        <div className="profile-edit__bar rise-in">
          <span className="min-w-0 flex-1 truncate text-sm">
            {nameError ? 'A display name is required.'
              : bioError ? `About is ${bioLen - bioMax} characters too long.`
                : 'Unsaved changes'}
          </span>
          <Button
            variant="tertiary"
            onClick={() => setDraft(saved)}
            isDisabled={busy}
          >
            Reset
          </Button>
          <Button
            variant="primary"
            loading={busy}
            isDisabled={nameError || bioError || !!uploading}
            onClick={save}
          >
            Save
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Preview({ me, draft, base, avatarMenu, bannerMenu }) {
  const name = draft.displayName.trim() || me.user_id;
  return (
    <div
      className="profile-edit__card"
      data-themed={draft.themeTop ? 'true' : undefined}
      style={draft.themeTop
        ? { '--pc-theme-top': draft.themeTop, '--pc-theme-bottom': draft.themeBottom }
        : undefined}
    >
      <div className="profile-edit__banner" style={{ background: draft.accent }}>
        {draft.bannerRef ? (
          <AnimatedImage
            src={`${base}/_telium/v1/media/${draft.bannerRef}`}
            alt=""
            animated
            className="size-full object-cover"
          />
        ) : null}
        {bannerMenu}
      </div>
      <div className="profile-edit__face">
        <Avatar
          id={me.user_id}
          name={name}
          size="xl"
          mediaRef={draft.avatarRef}
          base={base}
        />
        {avatarMenu}
      </div>
      <div className="profile-edit__who">
        <div className="profile-edit__name">
          <EmojiText>{name}</EmojiText>
          {draft.pronouns.trim() ? (
            <span className="profile-edit__pronouns">{draft.pronouns.trim()}</span>
          ) : null}
        </div>
        <div className="profile-edit__handle">{me.user_id}</div>
        {draft.bio.trim() ? (
          <div className="profile-edit__bio"><BioText>{draft.bio}</BioText></div>
        ) : (
          <div className="profile-edit__bio profile-edit__bio--empty">Nothing written yet.</div>
        )}
      </div>
    </div>
  );
}

function baseline(profile) {
  const p = profile || {};
  return {
    displayName: p.display_name || '',
    pronouns: p.pronouns || '',
    bio: p.bio || '',
    accent: colorHex(p.accent_color),
    themeTop: themeOf(p.theme_colors)?.[0] || '',
    themeBottom: themeOf(p.theme_colors)?.[1] || '',
    avatarRef: p.avatar_ref || null,
    bannerRef: p.banner_ref || null,
    publicPageEnabled: p.public_page_enabled !== false,
    publicStatusEnabled: p.public_status_enabled === true,
    publicActivityEnabled: p.public_activity_enabled === true,
  };
}

function colorHex(value) {
  if (typeof value !== 'number') return '#5865f2';
  return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
}
