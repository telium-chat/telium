import assert from 'node:assert/strict'
import test from 'node:test'
import { publicAddress, parseTxtPointer, POINTER_LIMIT } from '../src/secure-discovery.js'

test('the directory refuses loopback, RFC1918, metadata and address-mapped ranges', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '::1', 'fd00::1',
    'fe80::1', '::ffff:127.0.0.1', '2002:7f00:1::',
  ]) assert.equal(publicAddress(ip), false, ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(publicAddress(ip), true, ip)
  }
})

test('one-line pointers are confined to the account domain and HTTPS', () => {
  assert.equal(parseTxtPointer('chat.example.com\n', 'example.com'), 'https://chat.example.com')
  assert.equal(parseTxtPointer('https://chat.example.com', 'example.com'), 'https://chat.example.com')
  for (const bad of [
    'https://attacker.com', 'https://evil-example.com', 'http://chat.example.com',
    'https://chat.example.com:8443', 'https://chat.example.com/path',
    'https://chat.example.com@attacker.com', 'https://chat.example.com\nhttps://attacker.com',
    'https://chat.example.com?token=x', 'https://chat.example.com/#x',
    'x'.repeat(POINTER_LIMIT + 1),
  ]) assert.throws(() => parseTxtPointer(bad, 'example.com'), undefined, bad)
})
