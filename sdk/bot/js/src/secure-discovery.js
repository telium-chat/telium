// Network boundary for untrusted public directory discovery.
// Uses HTTPS's original hostname for TLS verification while pinning a vetted
// public DNS answer for this one request. No redirects, no automatic decompression,
// bounded streaming, and an end-to-end timeout (including slow bodies).
import { lookup } from 'node:dns/promises'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'

export const DISCOVERY_LIMIT = 256 * 1024
export const POINTER_LIMIT = 512
export const TIMEOUT_MS = 8000

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7],
  ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
  ['2001::', 32], ['2002::', 16], ['64:ff9b::', 96],
]) blocked.addSubnet(network, prefix, 'ipv6')

// Node maps IPv4 addresses to ::ffff: addresses when checking BlockList.
// Banning ::ffff:0:0/96 would wrongly block *all* public IPv4 hosts.
export function publicAddress(ip) {
  const family = isIP(ip)
  return family !== 0 && !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

export function parseTxtPointer(body, domain) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > POINTER_LIMIT) {
    throw new Error('telium.txt exceeded 512 bytes')
  }
  const line = body.trim()
  if (!line || /[\r\n]/.test(line)) throw new Error('telium.txt must be one line')
  const target = new URL(/^[a-z]+:\/\//i.test(line) ? line : 'https://' + line)
  const host = target.hostname.toLowerCase()
  const account = domain.toLowerCase()
  if (target.protocol !== 'https:' || target.username || target.password || target.port
    || target.pathname !== '/' || target.search || target.hash
    || !(host === account || host.endsWith('.' + account))) {
    throw new Error('telium.txt must target an HTTPS account-domain subdomain')
  }
  return target.origin
}

async function pinnedHttps(url, limit, accept) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('discovery requires HTTPS without URL credentials')
  }
  // DNS resolution also counts against the request's deadline.
  let dnsTimer
  let records
  try {
    records = await Promise.race([
      lookup(parsed.hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        dnsTimer = setTimeout(() => reject(new Error('discovery DNS lookup timed out')), TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(dnsTimer)
  }
  if (records.length === 0 || records.some(({ address }) => !publicAddress(address))) {
    throw new Error('discovery hostname resolves to a non-public address')
  }
  const ip = records[0]
  return await new Promise((resolve, reject) => {
    const req = https.request(parsed, {
      method: 'GET',
      family: ip.family,
      lookup: (_host, options, callback) => {
        if (options?.all) callback(null, [ip])
        else callback(null, ip.address, ip.family)
      },
      headers: {
        Accept: accept,
        'Accept-Encoding': 'identity',
        'User-Agent': 'telium-bot-sdk/0.2.0',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.destroy()
        const error = new Error('discovery returned HTTP ' + res.statusCode)
        error.status = res.statusCode
        reject(error)
        return
      }
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > limit) {
        res.destroy()
        reject(new Error('discovery exceeded byte limit'))
        return
      }
      let size = 0
      const chunks = []
      res.on('data', (part) => {
        size += part.length
        if (size > limit) {
          res.destroy(new Error('discovery exceeded byte limit'))
        } else {
          chunks.push(part)
        }
      })
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })
    // A stalled TLS handshake and a slow response must obey the same deadline.
    const timer = setTimeout(() => req.destroy(new Error('discovery timed out')), TIMEOUT_MS)
    timer.unref?.()
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
    req.end()
  })
}

export async function getJson(url) {
  return JSON.parse(await pinnedHttps(url, DISCOVERY_LIMIT, 'application/json'))
}

export async function getText(url) {
  return pinnedHttps(url, POINTER_LIMIT, 'text/plain')
}
