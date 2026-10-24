#!/usr/bin/env node
/* Fill a scratch Telium server with a conversation worth photographing.
 *
 * The screenshot on the landing page is the site's one claim that any of this
 * exists, so it has to be of the real client talking to the real server. That
 * means the data behind it has to come from somewhere, and a committed script
 * is the only version of "somewhere" that anyone can re-run and check.
 *
 * Everything here goes through the public API — register, upload, create a
 * guild, invite, post — so the shot is of state a user could have produced.
 * The one exception is the clock, and it is argued for where it happens, at
 * `retime` near the bottom.
 *
 * Run: node scripts/capture/seed.mjs [base-url] [sqlite-path]
 * Prints the owner's session as JSON on stdout, for shoot.mjs to install.
 */

import sharp from 'sharp'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8449'
const DB_PATH = process.argv[3] ?? null
const PASSWORD = 'capture-only-not-a-secret'

const api = async (method, path, { token, body } = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${payload?.message ?? ''}`)
  }
  return payload
}

/* Bytes go up the same route the client's uploader uses: a raw body with the
   purpose in a header. The answer carries the capability, and a profile asset
   is not public, so the reference a profile stores is hash-plus-capability. */
const upload = async (token, bytes, { purpose, filename, mime, width, height }) => {
  const response = await fetch(`${BASE}/_telium/v1/media`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': mime,
      'x-telium-purpose': purpose,
      'x-telium-filename': filename,
      ...(width ? { 'x-telium-width': String(width) } : {}),
      ...(height ? { 'x-telium-height': String(height) } : {}),
    },
    body: bytes,
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`upload ${filename} → ${response.status} ${payload?.message ?? ''}`)
  return payload
}

const profileRef = (media) => `${media.hash}?cap=${media.capability}`

/* Faces, drawn here rather than committed as files.
 *
 * A member list of grey initials is the same admission as a member list of
 * user1…user6: nobody lives here. But a screenshot has no business carrying
 * photographs of anybody, so these are flat two-tone marks — the kind of thing
 * a person actually picks when they cannot be bothered with a photograph — and
 * they are generated, so the repository holds the recipe instead of six PNGs
 * nobody can account for. Bold shapes only: this is drawn at forty pixels. */
const MARKS = {
  arc: (bg, fg) =>
    `<path d="M48 216 A168 168 0 0 1 216 48" fill="none" stroke="${fg}" stroke-width="46" stroke-linecap="round"/>`,
  moon: (bg, fg) =>
    `<circle cx="120" cy="132" r="84" fill="${fg}"/><circle cx="188" cy="88" r="66" fill="${bg}"/>`,
  bars: (bg, fg) =>
    ['M72 184 L72 104', 'M128 200 L128 64', 'M184 184 L184 128']
      .map((d) => `<path d="${d}" stroke="${fg}" stroke-width="34" stroke-linecap="round" fill="none"/>`)
      .join(''),
  wave: (bg, fg) =>
    ['M60 100 h136', 'M60 160 h96']
      .map((d) => `<path d="${d}" stroke="${fg}" stroke-width="34" stroke-linecap="round" fill="none"/>`)
      .join(''),
  notch: (bg, fg) =>
    `<rect x="56" y="56" width="144" height="144" rx="28" fill="${fg}"/><circle cx="200" cy="200" r="58" fill="${bg}"/>`,
  grid: (bg, fg) =>
    [[68, 68], [148, 68], [68, 148]]
      .map(([x, y]) => `<rect x="${x}" y="${y}" width="40" height="40" rx="12" fill="${fg}"/>`)
      .join('') + `<circle cx="168" cy="168" r="24" fill="${fg}"/>`,
  ring: (bg, fg) =>
    `<circle cx="128" cy="128" r="70" fill="none" stroke="${fg}" stroke-width="38"/>`,
  peak: (bg, fg) =>
    `<path d="M128 62 L206 194 H50 Z" fill="${fg}"/><circle cx="128" cy="150" r="22" fill="${bg}"/>`,
  leaf: (bg, fg) =>
    `<path d="M128 36 C 196 106 200 162 128 220 C 56 162 60 106 128 36 Z" fill="${fg}"/>`
    + `<path d="M128 84 V 196" stroke="${bg}" stroke-width="16" stroke-linecap="round"/>`,
}

const face = (mark, bg, fg) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">`
      + `<rect width="256" height="256" fill="${bg}"/>${MARKS[mark](bg, fg)}</svg>`,
    ),
  )
    .png()
    .toBuffer()

/* A cast, not a list of test accounts. A member list of user1…user6 tells a
 * visitor the screenshot is a fixture; names tell them it is a place. */
const PEOPLE = [
  { localpart: 'nadia', name: 'Nadia Rahman', pronouns: 'she/her', status: 'online', mark: 'arc', bg: '#2f5d50', fg: '#cfe8dd' },
  { localpart: 'ilya', name: 'Ilya Voronov', pronouns: 'he/him', status: 'online', mark: 'bars', bg: '#2a4a7a', fg: '#cddffa' },
  { localpart: 'mei', name: 'Mei Watanabe', pronouns: 'she/her', status: 'online', mark: 'moon', bg: '#7a3350', fg: '#f6d6e2' },
  { localpart: 'rowan', name: 'Rowan Ellis', pronouns: 'they/them', status: 'dnd', mark: 'wave', bg: '#6a4a1f', fg: '#f2ddb6' },
  { localpart: 'tomas', name: 'Tomás Ferreira', pronouns: 'he/him', status: 'idle', mark: 'notch', bg: '#3d3a68', fg: '#dcd9f5' },
  { localpart: 'priya', name: 'Priya Nair', pronouns: 'she/her', status: 'online', mark: 'grid', bg: '#8a4522', fg: '#f7ddc9' },
]

/* Two roles that hoist and one that only colours, which is the distribution a
 * real guild has: the member list reads as a hierarchy, and a name in the
 * timeline can still be coloured by a role that does not head a group. Rowan
 * holds nothing, because somebody always holds nothing. */
const ROLES = [
  { key: 'maintainers', name: 'Maintainers', color: 0xc47f1a, hoist: true, members: ['nadia', 'mei'] },
  { key: 'infra', name: 'Infra', color: 0x3e86cc, hoist: true, members: ['ilya', 'tomas'] },
  { key: 'triage', name: 'Triage', color: 0x2f9166, hoist: false, members: ['priya'] },
]

/* Ordinary shop talk in an ordinary community. Deliberately not a tour of the
 * feature list — a screenshot of people advertising the product to each other
 * is the least convincing thing a screenshot can be.
 *
 * A link, a mention, a code span and one picture are in here because a chat
 * client that renders nothing but grey prose looks like a mockup of a chat
 * client. They are load-bearing lines of the conversation, not exhibits: the
 * code span is a field name somebody got wrong, the picture is the graph the
 * person who fixed the latency would obviously post. */
const SCRIPT = [
  { at: '09:04', by: 'nadia', text: 'morning — the Helsinki SFU pool came back overnight, so voice in here should stop dropping' },
  { at: '09:06', by: 'ilya', text: 'confirmed, 38 ms from Tallinn. it was 200+ all last week' },
  { at: '09:11', by: 'mei', text: 'oh thank god. I gave up and moved standup to a thread' },
  { at: '09:12', by: 'rowan', text: 'the thread worked though? honestly might keep it' },
  { at: '09:13', by: 'mei', text: 'it worked because three people showed up 🙃' },
  { at: '09:16', by: 'tomas', text: 'I read every word of it, I just had nothing to add' },
  { at: '09:17', by: 'nadia', text: 'the highest form of standup', react: ['😄', ['ilya', 'mei', 'rowan']] },
  { at: '10:41', by: 'priya', text: 'has anyone written down how we handle the archive channels? I keep re-deciding it every time someone asks' },
  { at: '10:43', by: 'rowan', text: 'not written down. it lives entirely in my head and I resent it', key: 'archive' },
  { at: '10:45', by: 'priya', text: 'put it in {#protocol} and I will turn it into something people can read', replyTo: 'archive' },
  { at: '10:46', by: 'rowan', text: 'deal. give me until friday' },
  { at: '10:49', by: 'nadia', text: '{@rowan} one thing before you start — the column is `archived_at`, not `archived`. I had it wrong in the last pass and someone will copy it' },
  { at: '11:58', by: 'ilya', text: 'while we are here — I moved my account off the old host last night and everything followed. guilds, DMs, the lot', key: 'moved' },
  { at: '12:01', by: 'nadia', text: 'how long did it take', replyTo: 'moved' },
  { at: '12:02', by: 'ilya', text: 'about forty seconds, most of which was me reading the confirmation twice' },
  { at: '12:04', by: 'tomas', text: 'that is the correct amount of paranoia for the button that moves your entire life', react: ['💯', ['nadia', 'priya']] },
  { at: '12:26', by: 'ilya', text: 'the week since the cutover, for anyone who enjoys a line going down', attach: 'latency' },
  { at: '12:27', by: 'ilya', text: 'their incident is still open at https://hel1.voicepool.net/status/1187 so I would not move anything back yet' },
  { at: '12:31', by: 'mei', text: 'lunch? the place with the terrible chairs and the good soup' },
  { at: '12:32', by: 'rowan', text: 'the chairs are part of the experience' },
  { at: '12:33', by: 'nadia', text: 'be there in ten' },
]

/* The rest of the guild, and the rest of the rail. A sidebar where every
   channel is the same weight, and a rail holding one server with nothing
   happening on it, are both pictures of an account nobody uses. */
const ELSEWHERE = [
  { channel: 'protocol', at: '13:02', by: 'rowan', text: 'starting the archive write-up in here so it stops living in my head' },
  { channel: 'protocol', at: '13:05', by: 'rowan', text: '{@nadia} does the retention line still apply to voice channels, or did we drop that when the recordings went away' },
  { channel: 'design', at: '13:19', by: 'mei', text: 'new empty state is in the design channel, tell me if the copy is too pleased with itself' },
]

const GUILDS = [
  {
    name: 'Low Orbit', owner: 'tomas', members: ['nadia', 'ilya'],
    mark: 'peak', bg: '#1e3f6b', fg: '#bcd6f7',
    talk: [
      { at: '13:26', by: 'tomas', text: 'launch slipped to sunday, the window on saturday is fully clouded over' },
      { at: '13:28', by: 'ilya', text: 'sunday works. I will bring the long lens this time' },
    ],
  },
  {
    name: 'Night Kitchen', owner: 'mei', members: ['nadia', 'rowan'],
    mark: 'leaf', bg: '#47305f', fg: '#e6d8f5',
    talk: [
      { at: '13:33', by: 'mei', text: 'six for saturday, unless someone is bringing a plus one' },
      { at: '13:38', by: 'rowan', text: 'I am bringing the bread, so somebody else has to do the pudding' },
      { at: '13:41', by: 'mei', text: '{@nadia} you said you had a thing about a lemon tart. is that a real thing or was that a joke' },
    ],
  },
]

/* The one picture in the shot. A week of round-trip times falling off a cliff
   on the day of the cutover: the graph the person who moved the pool would
   actually paste, drawn flat so it reads at the size the timeline gives it and
   legible against either theme. */
const latencyChart = () => {
  const W = 620
  const H = 168
  const pad = { l: 44, r: 16, t: 30, b: 26 }
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const ms = [212, 224, 198, 231, 205, 41, 38]
  const max = 260
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (days.length - 1)
  const y = (v) => H - pad.b - (v / max) * (H - pad.t - pad.b)
  const line = ms.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  const grid = [0, 100, 200]
    .map(
      (v) =>
        `<line x1="${pad.l}" y1="${y(v)}" x2="${W - pad.r}" y2="${y(v)}" stroke="#e5e8ee" stroke-width="1"/>`
        + `<text x="${pad.l - 10}" y="${y(v) + 4}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#98a0ae">${v}</text>`,
    )
    .join('')
  const ticks = days
    .map(
      (d, i) =>
        `<text x="${x(i)}" y="${H - 9}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#98a0ae">${d}</text>`,
    )
    .join('')
  const dots = ms
    .map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="#2f6f5e"/>`)
    .join('')
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
      + `<rect width="${W}" height="${H}" fill="#f8f9fb"/>`
      + `<text x="${pad.l - 10}" y="18" font-family="Helvetica, Arial, sans-serif" font-size="11" font-weight="600" fill="#5b6472">voice RTT, Tallinn → hel1 (ms)</text>`
      + grid
      + ticks
      + `<path d="${line}" fill="none" stroke="#2f6f5e" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
      + dots
      + `</svg>`,
    ),
  )
    .png()
    .toBuffer()
    .then((bytes) => ({ bytes, width: W, height: H }))
}

const main = async () => {
  const sessions = new Map()

  for (const person of PEOPLE) {
    const account = await api('POST', '/_telium/v1/register', {
      body: { localpart: person.localpart, password: PASSWORD, device_name: 'Capture' },
    })
    const avatar = await upload(account.access_token, await face(person.mark, person.bg, person.fg), {
      purpose: 'profile',
      filename: `${person.localpart}.png`,
      mime: 'image/png',
      width: 256,
      height: 256,
    })
    await api('PATCH', '/_telium/v1/profile', {
      token: account.access_token,
      body: { display_name: person.name, pronouns: person.pronouns, avatar_ref: profileRef(avatar) },
    })
    // Identity and guild roles are on the same binary here, so the assertion
    // exchange has a one-call shortcut. A real client does both halves.
    //
    // It has to come after the profile is finished: a guild copies the name and
    // the face out of the assertion at join time, so a session minted before the
    // avatar existed makes a member row that will never have one.
    const guild = await api('POST', '/_telium/v1/sessions/local', { token: account.access_token })
    sessions.set(person.localpart, { account, guildToken: guild.session_token })
  }

  const owner = sessions.get('nadia')

  const guild = await api('POST', '/_telium/v1/guilds', {
    token: owner.guildToken,
    body: { name: 'Foundry', alias: 'foundry' },
  })
  const guildId = guild.id ?? guild.guild?.id

  const icon = await upload(owner.account.access_token, await face('ring', '#b4532a', '#ffe7d4'), {
    purpose: 'profile', filename: 'foundry.png', mime: 'image/png', width: 256, height: 256,
  })
  await api('PATCH', `/_telium/v1/guilds/${guildId}`, {
    token: owner.guildToken,
    body: { icon_ref: profileRef(icon) },
  })

  const channel = async (body) =>
    api('POST', `/_telium/v1/guilds/${guildId}/channels`, { token: owner.guildToken, body })

  /* Creating a guild already creates its #general — making a second one leaves
     two channels with the same name and the client, reasonably, shows the empty
     one. Take the one that exists and give it a topic. */
  const { channels } = await api('GET', `/_telium/v1/guilds/${guildId}/channels`, {
    token: owner.guildToken,
  })
  const general = channels.find((c) => c.name === 'general')
  await api('PATCH', `/_telium/v1/channels/${general.id}`, {
    token: owner.guildToken,
    body: { topic: 'Anything. Move it somewhere else if it turns into a project.' },
  })

  const textCategory = await channel({ name: 'Foundry', type: 'category', position: 1 })
  const rooms = new Map([['general', general.id]])
  for (const [i, name] of ['protocol', 'design', 'archive'].entries()) {
    const made = await channel({ name, type: 'text', parent_id: textCategory.id, position: 2 + i })
    rooms.set(name, made.id)
  }

  const voiceCategory = await channel({ name: 'Voice', type: 'category', position: 5 })
  await channel({ name: 'Lounge', type: 'voice', parent_id: voiceCategory.id, position: 6 })
  await channel({ name: 'Focus room', type: 'voice', parent_id: voiceCategory.id, position: 7 })

  const invite = await api('POST', `/_telium/v1/guilds/${guildId}/invites`, {
    token: owner.guildToken,
    body: { channel_id: general.id },
  })
  for (const person of PEOPLE) {
    if (person.localpart === 'nadia') continue
    await api('POST', `/_telium/v1/invites/${invite.code}/join`, {
      token: sessions.get(person.localpart).guildToken,
    })
  }

  for (const role of ROLES) {
    const made = await api('POST', `/_telium/v1/guilds/${guildId}/roles`, {
      token: owner.guildToken,
      body: { name: role.name, color: role.color, hoist: role.hoist, mentionable: true },
    })
    for (const who of role.members) {
      await api('PATCH', `/_telium/v1/guilds/${guildId}/members/${encodeURIComponent(sessions.get(who).account.user_id)}`, {
        token: owner.guildToken,
        body: { add_roles: [made.id] },
      })
    }
  }

  // The angle-bracket form is what a channel mention is on the wire, and a
  // user mention is just the id — so the lines above are written with the
  // names people use and the ids are substituted in here.
  const resolve = (text) =>
    text
      .replace(/\{#([a-z]+)\}/g, (_, name) => `<#${rooms.get(name)}>`)
      .replace(/\{@([a-z]+)\}/g, (_, who) => sessions.get(who).account.user_id)

  const chart = await latencyChart()
  const chartMedia = await upload(sessions.get('ilya').account.access_token, chart.bytes, {
    purpose: 'attachment',
    filename: 'voice-rtt-week.png',
    mime: 'image/png',
    width: chart.width,
    height: chart.height,
  })

  const clock = []
  const post = async (channelId, line, byKey) => {
    const sent = await api('POST', `/_telium/v1/channels/${channelId}/messages`, {
      token: sessions.get(line.by).guildToken,
      body: {
        content: resolve(line.text),
        ...(line.replyTo ? { reply_to: byKey.get(line.replyTo) } : {}),
        ...(line.attach ? { attachments: [chartMedia] } : {}),
      },
    })
    clock.push({ id: sent.id, at: line.at })
    if (line.key) byKey.set(line.key, sent.id)
    if (line.react) {
      const [emoji, reactors] = line.react
      for (const who of reactors) {
        await api('PUT', `/_telium/v1/messages/${sent.id}/reactions/${encodeURIComponent(emoji)}/@me`, {
          token: sessions.get(who).guildToken,
        })
      }
    }
    return sent
  }

  const byKey = new Map()
  for (const line of SCRIPT) await post(general.id, line, byKey)
  for (const line of ELSEWHERE) await post(rooms.get(line.channel), line, byKey)

  /* The other two servers on the rail. They exist because a rail holding one
     tile is a rail nobody has used, and because unread is what a rail is for:
     one of these is merely busy and the other is addressed to the reader, and
     the two are drawn differently. Nadia is a guest in both, which is also why
     she has never read either. */
  const elsewhereSessions = sessions
  for (const spec of GUILDS) {
    const host = elsewhereSessions.get(spec.owner)
    const made = await api('POST', '/_telium/v1/guilds', {
      token: host.guildToken,
      body: { name: spec.name },
    })
    const id = made.id ?? made.guild?.id
    const art = await upload(host.account.access_token, await face(spec.mark, spec.bg, spec.fg), {
      purpose: 'profile', filename: `${spec.name.toLowerCase().replace(/\W+/g, '-')}.png`, mime: 'image/png', width: 256, height: 256,
    })
    await api('PATCH', `/_telium/v1/guilds/${id}`, { token: host.guildToken, body: { icon_ref: profileRef(art) } })
    const rooms2 = await api('GET', `/_telium/v1/guilds/${id}/channels`, { token: host.guildToken })
    const lobby = rooms2.channels.find((c) => c.name === 'general')
    const key = await api('POST', `/_telium/v1/guilds/${id}/invites`, {
      token: host.guildToken,
      body: { channel_id: lobby.id },
    })
    for (const who of spec.members) {
      await api('POST', `/_telium/v1/invites/${key.code}/join`, { token: sessions.get(who).guildToken })
    }
    for (const line of spec.talk) await post(lobby.id, line, byKey)
  }

  await retime(clock)

  const home = owner.account
  process.stdout.write(
    `${JSON.stringify(
      {
        session: {
          home: {
            base: BASE,
            domain: home.server_name,
            token: home.access_token,
            user_id: home.user_id,
            device_id: home.device_id,
            expires_at: home.expires_at,
            device_secret: home.device_secret ?? null,
          },
          servers: {},
        },
        guild_id: guildId,
        channel_id: general.id,
        /* Presence is per-gateway-connection, so the only honest way to
           photograph a member list that is not five grey dots is to actually
           connect these accounts while the shutter is open. shoot.mjs does. */
        crew: PEOPLE.filter((p) => p.localpart !== 'nadia').map((p) => ({
          user_id: sessions.get(p.localpart).account.user_id,
          token: sessions.get(p.localpart).guildToken,
          status: p.status,
        })),
      },
      null,
      2,
    )}\n`,
  )
}

/* The clock, and the one thing in this file that does not go through the API.
 *
 * `POST /messages` stamps `created_at` on the server, deliberately: a sender
 * who can choose when a message happened can rewrite a conversation, so there
 * is no field to send and there should not be one. The consequence for a seed
 * script is that twenty-one messages arrive inside one second, and the shot
 * that comes out has every line in an afternoon's conversation stamped 20:55.
 * That single repeated number does more to tell a visitor they are looking at
 * generated data than everything else on the page does to tell them otherwise.
 *
 * So the times, and only the times, are written straight into the scratch
 * SQLite file after the seeding is done — a database that run.mjs creates
 * empty, keeps for about eight seconds, and deletes on the next run. Nothing
 * else is touched: one `UPDATE messages SET created_at` per row, no content,
 * no authorship, no reactions, no ids. History is ordered by ULID rather than
 * by this column, so moving it changes what the shot says the time was and
 * nothing at all about what happened.
 *
 * The day is the most recent one on which the last line has already gone past
 * in UTC — the timezone shoot.mjs photographs in — so the conversation always
 * reads as something that finished a little while ago rather than as a
 * transcript from the future.
 */
const retime = async (clock) => {
  if (!DB_PATH || !clock.length) return
  const minutes = (at) => Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5))
  const now = Date.now()
  const today = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  )
  const last = Math.max(...clock.map((row) => minutes(row.at)))
  const day = today + last * 60_000 <= now - 3 * 60_000 ? today : today - 86_400_000

  // Seeded in posting order and never allowed to go backwards: the timeline
  // groups consecutive messages by the gap between them, so two lines sharing a
  // minute still need distinct, increasing stamps.
  let previous = 0
  const stamps = clock.map((row, i) => {
    const ts = Math.max(day + minutes(row.at) * 60_000 + ((i * 37) % 60) * 1000, previous + 7_000)
    previous = ts
    return { id: row.id, ts }
  })

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA busy_timeout = 5000')
  const set = db.prepare('UPDATE messages SET created_at = ? WHERE id = ?')
  for (const { id, ts } of stamps) set.run(ts, id)
  db.close()
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
