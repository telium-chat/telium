/* Formatting helpers the directory pages and the /list wizard both need.
 *
 * These were split out of lib/servers.ts and lib/sfus.ts because the wizard's
 * client script needs them too, and importing those modules would pull the
 * registry JSON and the hourly probe status into the page bundle. Everything
 * here is pure — labels, ranks and formatters keyed by the schema's own
 * vocabulary — with no data import at all.
 */

export type SizeBand = '<100' | '100-1k' | '1k-10k' | '10k+'

export type CapacityBand = '<100m' | '100m' | '1g' | '10g'

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
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${Math.round(mb)} MB`
}

/** Roles are the honest summary of what a server actually offers. */
export const roleList = (roles: Record<string, boolean> | null): string[] =>
  roles ? Object.entries(roles).filter(([, on]) => on).map(([role]) => role) : []
