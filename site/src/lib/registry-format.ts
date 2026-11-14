/* Formatting helpers the directory pages and the /list wizard both need.
 *
 * These were split out of lib/servers.ts and lib/sfus.ts because the wizard's
 * client script needs them too, and importing those modules would pull the
 * registry JSON and the hourly probe status into the page bundle. Everything
 * here is pure — labels, ranks and formatters keyed by the schema's own
 * vocabulary — with no data import at all.
 */

export type CapacityBand = '<100m' | '100m' | '1g' | '10g'

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

export const formatBytes = (bytes: number | null): string => {
  if (bytes === null || !Number.isFinite(bytes)) return '–'
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GiB` : `${Math.round(mb)} MiB`
}

/** Roles are the honest summary of what a server actually offers. */
export const roleList = (roles: Record<string, boolean> | null): string[] =>
  roles ? Object.entries(roles).filter(([, on]) => on).map(([role]) => role) : []

/** "7 days", "12 hours"; zero means the server sets no limit. */
export const formatSpan = (secs: number | null, unlimited = 'No limit'): string => {
  if (secs === null || !Number.isFinite(secs)) return '–'
  if (secs <= 0) return unlimited
  const day = 86400
  if (secs >= day) { const d = Math.round(secs / day); return `${d} day${d === 1 ? '' : 's'}` }
  if (secs >= 3600) { const h = Math.round(secs / 3600); return `${h} hour${h === 1 ? '' : 's'}` }
  return `${Math.max(1, Math.round(secs / 60))} min`
}

/** Flag emoji from the trailing ISO country code in a region label ("Frankfurt, DE"). */
export const flagOf = (label: string): string => {
  const code = /,\s*([A-Za-z]{2})\s*$/.exec(label)?.[1]?.toUpperCase()
  return code ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '🌐'
}


/** What an ordinary account can keep stored at once, from the server's default upload policy. */
export const formatStorage = (
  policy: string | null,
  enabled: boolean | null,
  quotaBytes: number | null,
): string => {
  if (enabled === false || policy === 'disabled') return 'No uploads'
  if (policy === 'enabled') return 'Unlimited'
  if (policy === 'quota') return quotaBytes === null ? '–' : formatBytes(quotaBytes)
  return '–'
}
