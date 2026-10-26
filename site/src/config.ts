/* Every outbound URL on the site, in one file.
 *
 * Nothing in the Telium repository commits a canonical domain — every host in
 * the code and the specs is a placeholder (`home.example`, `guilds.example`) —
 * so the values below are the intended ones, not confirmed ones. `telium.chat`
 * follows from the `telium-chat` GitHub org; change it here and the whole site
 * follows. */

export const SITE = {
  name: 'Telium',
  domain: 'telium.chat',
  /* Used for the <title> suffix and social metadata. It describes the user
     choice the site should make clear before it explains the architecture. */
  tagline: 'Group chat with a server you can choose.',
} as const

export const URLS = {
  /* The client we host. A convenience, not a destination — it is the same
     static bundle anyone else can serve, pointed at whichever homeserver you
     give it. It lives on this domain, at the app's own front door: a visitor
     who is signed in gets the app there, one who is not gets its sign-in
     screen. The site stays where it is. */
  client: '/channels/@me',
  servers: '/servers',
  download: '/download',
  github: 'https://github.com/telium-chat/telium',
  docs: 'https://docs.telium.chat',
  mediaSpec: 'https://docs.telium.chat/media',
  migrationSpec: 'https://docs.telium.chat/migration',
  license: 'https://github.com/telium-chat/telium/blob/main/LICENSE',
  registry: 'https://github.com/telium-chat/telium/tree/main/site/registry',
  releases: 'https://github.com/telium-chat/telium/releases',
  downloads: {
    // The artifact names are stable across releases (`build.artifactName` in
    // web/electron/package.json), because a download URL addresses an exact
    // name. The same file is what the signed update manifest addresses under
    // its own tag, so there is one copy and no second name to drift from it.
    //
    // Both desktop buttons resolve through `desktop-latest`, a rolling release
    // whose tag never moves. It is a "latest" pointer that belongs to this
    // train, rather than GitHub's `releases/latest`, which is one slot shared
    // by every train in the repository: a server or Android release that took
    // it would 404 both desktop buttons. See
    // `scripts/publish-desktop-latest.sh`.
    windows: 'https://github.com/telium-chat/telium/releases/download/desktop-latest/Telium_Setup_x64.exe',
    linux: 'https://github.com/telium-chat/telium/releases/download/desktop-latest/Telium_x86_64.AppImage',
    // Android has its own rolling release for the same reason, and one more:
    // it is a preview train whose versions cannot be ordered against the
    // desktop's. See `.github/workflows/build-android-arm64.yml`.
    android: 'https://github.com/telium-chat/telium/releases/download/android-latest/Telium_arm64.apk',
  },
} as const

/* Obtainium tracks an app's own release feed and updates it in place, which is
 * the closest thing Android has to the desktop app's self-update.
 *
 * The link has to carry settings, not just the repository. Three things go
 * wrong with a bare `obtainium://add/https://github.com/telium-chat/telium`:
 *
 *   - Obtainium skips prereleases by default. Nothing published today is one,
 *     so `includePrereleases` changes nothing today; it is a guard so that an
 *     Android build marked prerelease later is not skipped in favour of the
 *     newest desktop release, which contains no APK.
 *   - The repository publishes several trains. The title filter keeps
 *     Obtainium on `Telium for Android 0.1.3 (preview)` and off `Telium for
 *     Android — latest preview`, whose tag is `android-latest` -- a name
 *     Obtainium cannot order against a real version, so tracking it would
 *     leave every install unable to tell whether it was current.
 *   - `apkFilterRegEx` pins the asset, so a future universal APK does not
 *     silently become the thing Obtainium downloads.
 *
 * The `id` is local bookkeeping inside Obtainium and matches the Android
 * applicationId, so the entry is recognisable in its own list. */
const OBTAINIUM_CONFIG = {
  id: 'chat.telium.desktop',
  url: URLS.github,
  author: 'Telium',
  name: 'Telium',
  additionalSettings: {
    includePrereleases: true,
    filterReleaseTitlesByRegEx: '^Telium for Android [0-9]',
    apkFilterRegEx: 'arm64',
  },
} as const

/* The https form, not a bare `obtainium://` link. A bare one does nothing at
 * all for the majority of visitors, who do not have Obtainium installed; this
 * page checks the payload, tries to open the app, and offers to install it if
 * nothing happened. The JSON is the only encoded part -- the scheme stays
 * literal, which is the shape the redirect expects. */
export const OBTAINIUM_URL =
  'https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/'
  + encodeURIComponent(JSON.stringify(OBTAINIUM_CONFIG))
