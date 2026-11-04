import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPublicRelayUrl, isPublicIp } from './probe-sfus.mjs'

test('public SFU probe rejects loopback, private and reserved literal IP addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.4', '172.16.0.1', '192.168.1.3', '169.254.1.1', '0.0.0.0', '100.64.0.1', '192.0.2.10', '203.0.113.1', '::1', 'fc00::1', 'fe80::2', '2001:db8::1']) {
    assert.equal(isPublicIp(ip), false, ip)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicIp(ip), true, ip)
  }
})

test('SFU probe refuses DNS names with any private result', async () => {
  const resolve = async () => [{ address: '8.8.8.8' }, { address: '10.0.0.2' }]
  await assert.rejects(assertPublicRelayUrl('https://relay.example/health', resolve), /non-public/)
})

test('SFU probe accepts public DNS only with HTTPS and without credentials', async () => {
  const resolve = async () => [{ address: '1.1.1.1' }]
  await assert.doesNotReject(assertPublicRelayUrl('https://relay.example/health', resolve))
  await assert.rejects(assertPublicRelayUrl('http://relay.example/health', resolve), /HTTPS/)
  await assert.rejects(assertPublicRelayUrl('https://user:pass@relay.example/health', resolve), /HTTPS/)
})
