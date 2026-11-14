/* Country → directory region. One source of truth for the /list wizard (which
 * builds the dropdown from it) and the registry validator (which refuses a
 * label or code that disagrees with it), so a typo cannot reach the registry.
 *
 * The directory's `region.code` is a coarse proximity bucket the signed
 * recommendation feed also carries, so it stays in the registry; it is just
 * derived from the country now instead of typed. Countries that span several
 * buckets (US, Canada) list all of them and the operator picks the nearest.
 * Plain JS, no imports, so Node scripts and the browser bundle can both use it.
 */

export const REGION_CODES = [
  'af-south', 'ap-east', 'ap-south', 'ap-southeast', 'eu-central', 'eu-north',
  'eu-west', 'me-central', 'na-central', 'na-east', 'na-west', 'oc-southeast', 'sa-east',
]

export const REGION_NAME = {
  'af-south': 'Africa',
  'ap-east': 'East Asia',
  'ap-south': 'South & Central Asia',
  'ap-southeast': 'Southeast Asia',
  'eu-central': 'Central & Eastern Europe',
  'eu-north': 'Northern Europe',
  'eu-west': 'Western Europe',
  'me-central': 'Middle East',
  'na-central': 'Central North America',
  'na-east': 'Eastern North America',
  'na-west': 'Western North America',
  'oc-southeast': 'Oceania',
  'sa-east': 'South America',
}

const group = (code, countries) => countries.split(' ').map((c) => [c, [code]])

/** ISO 3166-1 alpha-2 → the region codes that country may use (first is the default). */
export const COUNTRY_REGIONS = Object.fromEntries([
  ...group('eu-west', 'GB IE FR ES PT BE NL LU IS AD MC IM JE GG GI'),
  ...group('eu-north', 'SE NO FI DK EE LV LT AX FO'),
  ...group('eu-central', 'DE AT CH LI IT SM VA PL CZ SK HU SI HR BA RS ME MK AL XK BG RO MD UA BY GR CY MT RU'),
  ...group('me-central', 'TR IL PS JO LB SY IQ IR SA KW BH QA AE OM YE EG GE AM AZ'),
  ...group('af-south', 'ZA NA BW ZW ZM MZ MW LS SZ AO MG MU SC KE TZ UG RW BI ET SO DJ ER SS SD DZ MA TN LY NG GH SN CI CM CD CG GA GQ BJ BF ML NE TD TG LR SL GN GW GM MR CV ST KM CF'),
  ...group('ap-south', 'IN PK BD LK NP BT MV AF KZ UZ TM KG TJ'),
  ...group('ap-east', 'CN HK TW MO JP KR KP MN'),
  ...group('ap-southeast', 'SG MY ID TH VN PH KH LA MM BN TL'),
  ...group('oc-southeast', 'AU NZ PG FJ NC PF WS TO VU SB FM KI'),
  ...group('sa-east', 'BR AR CL UY PY BO PE EC CO VE GY SR GF FK'),
  ...group('na-central', 'MX GT BZ SV HN NI CR PA'),
  ...group('na-east', 'BM GL CU JM HT DO PR BS BB TT AG DM GD KN LC VC AW CW'),
  ['US', ['na-east', 'na-central', 'na-west']],
  ['CA', ['na-east', 'na-central', 'na-west']],
])

/** "Frankfurt, DE" — the one label shape the directory accepts. */
export const buildLabel = (city, country) => `${String(city).trim()}, ${country}`

export const parseLabel = (label) => {
  const m = /^(.{2,}?),\s*([A-Z]{2})$/.exec(String(label ?? ''))
  return m ? { city: m[1].trim(), country: m[2] } : null
}

/** Null when consistent; otherwise a sentence saying what is wrong. */
export const checkRegion = (region) => {
  const parsed = parseLabel(region?.label)
  if (!parsed) return 'region.label must read "City, CC" with a two-letter country code, e.g. "Frankfurt, DE"'
  const allowed = COUNTRY_REGIONS[parsed.country]
  if (!allowed) return `region.label country "${parsed.country}" is not a recognised country code`
  if (!allowed.includes(region.code)) {
    return `region.code "${region.code}" does not fit ${parsed.country}; use ${allowed.map((c) => `"${c}"`).join(' or ')}`
  }
  return null
}
