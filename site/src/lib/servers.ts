/* Merge what operators declared (registry/servers.json) with what we measured
 * (data/status.json) into the one shape the table renders from.
 *
 * Runs at build time only. Which half a given field came from matters — the
 * page labels declared figures as declared — so the merge keeps them in named
 * groups rather than flattening everything into one bag of properties.
 */

import registry from '../../registry/servers.json'
import status from '../../data/status.json'

export type SizeBand = '<100' | '100-1k' | '1k-10k' | '10k+'

export interface RegistryEntry {
  domain: string
  name: string
  description: string
  region: { label: string; code: string }
  size_band: SizeBand
  operator: { name: string; contact: string }
  recommendations?: { opt_in: boolean }
  added: string
}

export interface RecommendationDecision {
  eligible: boolean
  reasons: string[]
  weight: number
}

export interface ProbeResult {
  ok: boolean
  checked_at: string
  error: string | null
  server_name: string | null
  api_origin: string | null
  protocol_version: string | null
  moved_to: string | null
  sunset: string | null
  registration_open: boolean | null
  server_version: string | null
  roles: Record<string, boolean> | null
  features: Record<string, boolean> | null
  max_file_bytes: number | null
  recommendations_accepting: boolean | null
  recommendations_referral_weight: number | null
  uptime_30d: number | null
  samples: number
  first_probe_at: string | null
  recommendation: RecommendationDecision | null
}

export interface Server extends RegistryEntry {
  probe: ProbeResult
}

const EMPTY_PROBE: ProbeResult = {
  ok: false,
  checked_at: '',
  error: 'not yet probed',
  server_name: null,
  api_origin: null,
  protocol_version: null,
  moved_to: null,
  sunset: null,
  registration_open: null,
  server_version: null,
  roles: null,
  features: null,
  max_file_bytes: null,
  recommendations_accepting: null,
  recommendations_referral_weight: null,
  uptime_30d: null,
  samples: 0,
  first_probe_at: null,
  recommendation: null,
}

const probes = (status as { servers: Record<string, Partial<ProbeResult>> }).servers ?? {}

export const servers: Server[] = (registry as RegistryEntry[]).map((entry) => ({
  ...entry,
  probe: { ...EMPTY_PROBE, ...probes[entry.domain] },
}))

export const generatedAt: string = (status as { generated_at?: string }).generated_at ?? ''

/** Servers anyone can join right now — the directory's whole reason to exist. */
export const openServers = servers.filter((server) => server.probe.registration_open === true)

/** Servers that have expressed interest in the automatic beginner pool. */
export const recommendationServers = servers.filter((server) => (
  server.recommendations?.opt_in === true
  || server.probe.recommendations_accepting !== null
))

export const RECOMMENDATION_REASON_LABEL: Record<string, string> = {
  operator_not_opted_in: 'Registry opt-in is off',
  operator_contact_missing: 'Operator contact is missing',
  listing_too_new: 'Registry listing is still maturing',
  insufficient_observed_age: 'Needs seven days of observed probe history',
  unreachable: 'Server is currently unreachable',
  identity_domain_mismatch: 'Advertised identity domain does not match the registry',
  insecure_or_invalid_api_origin: 'API origin must be a valid HTTPS origin',
  registration_closed: 'Registration is closed',
  incompatible_protocol: 'Protocol version is not currently compatible',
  server_moved: 'Server has announced a move',
  server_sunsetting: 'Server is sunsetting',
  identity_role_unavailable: 'Identity/account role is unavailable',
  stale_probe: 'Latest health probe is stale',
  insufficient_probe_history: 'Not enough probe samples yet',
  uptime_below_minimum: 'Measured uptime is below the recommendation threshold',
  live_recommendations_disabled: 'Live referral acceptance is off',
  no_live_referral_weight: 'Live referral weight is zero',
}

export const recommendationReason = (reason: string): string =>
  RECOMMENDATION_REASON_LABEL[reason] ?? reason.replace(/_/g, ' ')

/* Ordering for the server-rendered table. Latency is the default sort once the
 * browser has measured it, but latency does not exist at build time, so the
 * pre-JS order is the next most useful thing: open first, then reliable, then
 * alphabetical. Someone with JavaScript off still gets a considered list. */
export const defaultOrder: Server[] = [...servers].sort((a, b) => {
  const open = Number(b.probe.registration_open === true) - Number(a.probe.registration_open === true)
  if (open) return open
  const reachable = Number(b.probe.ok) - Number(a.probe.ok)
  if (reachable) return reachable
  const uptime = (b.probe.uptime_30d ?? 0) - (a.probe.uptime_30d ?? 0)
  if (uptime) return uptime
  return a.name.localeCompare(b.name)
})

export const SIZE_LABEL: Record<SizeBand, string> = {
  '<100': 'Under 100',
  '100-1k': '100 – 1k',
  '1k-10k': '1k – 10k',
  '10k+': '10k+',
}

/** Sort weight for the size column; the bands are ranges, so sort by their floor. */
export const SIZE_RANK: Record<SizeBand, number> = {
  '<100': 0,
  '100-1k': 1,
  '1k-10k': 2,
  '10k+': 3,
}

export const formatBytes = (bytes: number | null): string => {
  if (bytes === null || !Number.isFinite(bytes)) return '—'
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${Math.round(mb)} MB`
}

/** Roles are the honest summary of what a server actually offers. */
export const roleList = (roles: Record<string, boolean> | null): string[] =>
  roles ? Object.entries(roles).filter(([, on]) => on).map(([role]) => role) : []
