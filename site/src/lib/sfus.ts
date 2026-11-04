/* Merge what relay operators declared (registry/sfus.json) with what we measured
 * (data/sfu-status.json) into the one shape the table renders from.
 *
 * Runs at build time only. Declared facts (the capacity band, the operator) are
 * labelled as declared; measured facts (uptime, reachability, accepting) come
 * from the hourly probe. A relay's live load is deliberately absent — it changes
 * by the minute and servers read it from the relay itself.
 */

import registry from '../../registry/sfus.json'
import status from '../../data/sfu-status.json'

export type CapacityBand = '<100m' | '100m' | '1g' | '10g'

export interface RegistryEntry {
  url: string
  name: string
  description: string
  region: { label: string; code: string }
  capacity_band: CapacityBand
  operator: { name: string; contact: string }
  weight?: number
  pubkey_hint?: string
  feed?: { opt_in: boolean }
  added: string
}

export interface EligibilityDecision {
  eligible: boolean
  reasons: string[]
  weight: number
}

export interface ProbeResult {
  ok: boolean
  checked_at: string
  error: string | null
  accepting: boolean | null
  rooms: number | null
  participants: number | null
  service: string | null
  uptime_30d: number | null
  samples: number
  first_probe_at: string | null
  eligibility: EligibilityDecision | null
}

export interface Sfu extends RegistryEntry {
  probe: ProbeResult
}

const EMPTY_PROBE: ProbeResult = {
  ok: false,
  checked_at: '',
  error: 'not yet probed',
  accepting: null,
  rooms: null,
  participants: null,
  service: null,
  uptime_30d: null,
  samples: 0,
  first_probe_at: null,
  eligibility: null,
}

const probes = (status as { sfus: Record<string, Partial<ProbeResult>> }).sfus ?? {}

export const sfus: Sfu[] = (registry as RegistryEntry[]).map((entry) => ({
  ...entry,
  probe: { ...EMPTY_PROBE, ...probes[entry.url] },
}))

export const generatedAt: string = (status as { generated_at?: string }).generated_at ?? ''

/** Relays opted into the signed feed servers fetch for automatic mode. */
export const feedSfus = sfus.filter((relay) => relay.feed?.opt_in === true)

export const ELIGIBILITY_REASON_LABEL: Record<string, string> = {
  operator_not_opted_in: 'Feed opt-in is off',
  operator_contact_missing: 'Operator contact is missing',
  insecure_or_invalid_relay_url: 'Relay URL must be a valid HTTPS origin',
  unknown_capacity_band: 'Capacity band is not one of the known bands',
  listing_too_new: 'Registry listing is still maturing',
  insufficient_observed_age: 'Needs seven days of observed probe history',
  unreachable: 'Relay is currently unreachable',
  stale_probe: 'Latest health probe is stale',
  insufficient_probe_history: 'Not enough probe samples yet',
  uptime_below_minimum: 'Measured uptime is below the feed threshold',
}

export const eligibilityReason = (reason: string): string =>
  ELIGIBILITY_REASON_LABEL[reason] ?? reason.replace(/_/g, ' ')

/* Ordering: reachable first, then proven (uptime), then alphabetical. With
 * JavaScript off this is the order; the browser re-sorts by measured latency. */
export const defaultOrder: Sfu[] = [...sfus].sort((a, b) => {
  const reachable = Number(b.probe.ok) - Number(a.probe.ok)
  if (reachable) return reachable
  const uptime = (b.probe.uptime_30d ?? 0) - (a.probe.uptime_30d ?? 0)
  if (uptime) return uptime
  return a.name.localeCompare(b.name)
})

export const BAND_LABEL: Record<CapacityBand, string> = {
  '<100m': 'Under 100 Mbps',
  '100m': '100 Mbps',
  '1g': '1 Gbps',
  '10g': '10 Gbps',
}

/** Sort weight for the band column; the bands are ordered floors. */
export const BAND_RANK: Record<CapacityBand, number> = {
  '<100m': 0,
  '100m': 1,
  '1g': 2,
  '10g': 3,
}
