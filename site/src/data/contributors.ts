export type Contributor = {
  name: string
  handle: string
  role: string
  majorContribution: string
  href: string
  avatarUrl: string
  initials: string
}

export type ContributorGroup = {
  title: string
  description: string
  icon: string
  tone: 'violet' | 'green' | 'pink' | 'blue'
  contributors: Contributor[]
}

/*
 * This list is deliberately curated instead of generated from commit counts.
 * A credits page should explain what people shaped, not turn contribution into
 * a leaderboard. Keep the wording concrete and update it when somebody's role
 * in the project changes.
 *
 * Empty groups are intentional: the People page keeps the credits layout
 * without inventing contributors just to fill a slot.
 */
export const contributorGroups: ContributorGroup[] = [
  {
    title: 'Founders / Project Leads',
    description: 'Setting the direction and building the foundations of Telium.',
    icon: 'crown',
    tone: 'violet',
    contributors: [
      {
        name: '20plays',
        handle: '20plays',
        role: 'Founder / project lead',
        majorContribution: 'Product direction, desktop experience, and rich presence',
        href: 'https://github.com/20plays',
        avatarUrl: 'https://avatars.githubusercontent.com/u/63814200?v=4&s=160',
        initials: '20',
      },
      {
        name: '67plays',
        handle: '67plays',
        role: 'Founder / core engineering',
        majorContribution: 'Federation, account migration, failover, and server lifecycle work',
        href: 'https://github.com/67plays',
        avatarUrl: 'https://avatars.githubusercontent.com/u/316839895?v=4&s=160',
        initials: '67',
      },
    ],
  },
  {
    title: 'Core Engineering',
    description: 'Protocol, federation, calling, storage, and the machinery behind the product.',
    icon: 'code',
    tone: 'green',
    contributors: [],
  },
  {
    title: 'Ecosystem / Clients',
    description: 'Building independent clients and apps on top of Telium.',
    icon: 'app-window',
    tone: 'violet',
    contributors: [
      {
        name: 'alp',
        handle: 'alpwrk',
        role: 'Ecosystem / client developer',
        majorContribution: 'Rhein, a native Telium client for Linux — Rust and GPUI, with encrypted DMs and calls',
        href: 'https://github.com/alpwrk',
        avatarUrl: 'https://avatars.githubusercontent.com/u/200269902?v=4&s=160',
        initials: 'A',
      },
    ],
  },
  {
    title: 'Web & Reliability',
    description: 'Improving the public site and hardening the edges around the product.',
    icon: 'shield-check',
    tone: 'pink',
    contributors: [
      {
        name: 'resslr',
        handle: 'resslr',
        role: 'Web & reliability',
        majorContribution: 'Marketing-site polish, media hardening, and security headers',
        href: 'https://github.com/resslr',
        avatarUrl: 'https://avatars.githubusercontent.com/u/122219240?v=4&s=160',
        initials: 'R',
      },
    ],
  },
  {
    title: 'Community / Infrastructure',
    description: 'Testing, operations, deployment, feedback, and work outside the featured list.',
    icon: 'users',
    tone: 'blue',
    contributors: [],
  },
]

const featuredHandles = new Set(
  contributorGroups.flatMap((group) => group.contributors.map((contributor) => contributor.handle)),
)

export const featuredContributorCount = featuredHandles.size
