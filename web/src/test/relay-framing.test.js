import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { clientFrame, createFrameReader } = require('../../electron/relay.cjs');

function collector() {
  const seen = { messages: [], pings: [], closes: [], errors: [] };
  seen.feed = createFrameReader({
    onMessage: (binary, payload) => seen.messages.push({ binary, payload: Buffer.from(payload) }),
    onPing: (payload) => seen.pings.push(Buffer.from(payload)),
    onClose: (event) => seen.closes.push(event),
    onError: (error) => seen.errors.push(error),
  });
  return seen;
}

function serverFrame(opcode, payload, { fin = true } = {}) {
  const body = Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = body.length;
  } else if (body.length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, body]);
}

describe('client frames', () => {
  it('are masked with a fresh mask and use each length encoding at its boundary', () => {
    const first = clientFrame(0x2, Buffer.from('payload'));
    expect(first[1] & 0x80).toBeTruthy();
    expect(first.equals(clientFrame(0x2, Buffer.from('payload')))).toBe(false);
    expect(clientFrame(0x2, Buffer.alloc(125)).length).toBe(2 + 4 + 125);
    expect(clientFrame(0x2, Buffer.alloc(126)).length).toBe(4 + 4 + 126);
    expect(clientFrame(0x2, Buffer.alloc(65_535)).length).toBe(4 + 4 + 65_535);
    expect(clientFrame(0x2, Buffer.alloc(65_536)).length).toBe(10 + 4 + 65_536);
  });
});

describe('server frame reader', () => {
  it('reads text, binary, pings and several frames per chunk', () => {
    const seen = collector();
    seen.feed(Buffer.concat([
      serverFrame(0x1, 'one'),
      serverFrame(0x9, Buffer.from('ping')),
      serverFrame(0x2, Buffer.from([1, 2, 3])),
    ]));
    expect(seen.messages.map((m) => m.binary)).toEqual([false, true]);
    expect(seen.messages[0].payload.toString()).toBe('one');
    expect([...seen.messages[1].payload]).toEqual([1, 2, 3]);
    expect(seen.pings.map((p) => p.toString())).toEqual(['ping']);
    expect(seen.errors).toEqual([]);
  });

  it('reassembles fragments, with a ping in the middle kept out of the payload', () => {
    const seen = collector();
    seen.feed(serverFrame(0x2, Buffer.from('aa'), { fin: false }));
    seen.feed(serverFrame(0x9, Buffer.from('hi')));
    seen.feed(serverFrame(0x0, Buffer.from('bb'), { fin: false }));
    seen.feed(serverFrame(0x0, Buffer.from('cc')));
    expect(seen.messages).toHaveLength(1);
    expect(seen.messages[0]).toMatchObject({ binary: true });
    expect(seen.messages[0].payload.toString()).toBe('aabbcc');
    expect(seen.pings[0].toString()).toBe('hi');
  });

  it('survives a 16-bit length header delivered one byte at a time', () => {
    const seen = collector();
    for (const byte of serverFrame(0x2, Buffer.alloc(300, 7))) seen.feed(Buffer.from([byte]));
    expect(seen.messages).toHaveLength(1);
    expect(seen.messages[0].payload.length).toBe(300);
    expect(seen.messages[0].payload.every((b) => b === 7)).toBe(true);
  });

  it('reports close code and reason, and 1005 for an empty close', () => {
    const seen = collector();
    seen.feed(serverFrame(0x8, Buffer.concat([Buffer.from([0x0f, 0xad]), Buffer.from('budget spent')])));
    seen.feed(serverFrame(0x8, Buffer.alloc(0)));
    expect(seen.closes).toEqual([{ code: 4013, reason: 'budget spent' }, { code: 1005, reason: '' }]);
  });

  const huge = () => {
    const header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(1n << 40n, 2);
    return header;
  };
  const rsv = () => {
    const frame = serverFrame(0x2, Buffer.from('x'));
    frame[0] |= 0x40;
    return frame;
  };

  it.each([
    ['a masked server frame', () => clientFrame(0x2, Buffer.from('nope'))],
    ['an unnegotiated RSV bit', rsv],
    ['a fragmented control frame', () => serverFrame(0x9, Buffer.from('x'), { fin: false })],
    ['an orphan continuation', () => serverFrame(0x0, Buffer.from('orphan'))],
    ['an implausibly large announced length', huge],
  ])('refuses %s and stops parsing afterwards', (_, bad) => {
    const seen = collector();
    seen.feed(bad());
    seen.feed(serverFrame(0x1, 'would have been fine'));
    expect(seen.messages).toEqual([]);
    expect(seen.pings).toEqual([]);
    expect(seen.errors).toHaveLength(1);
  });
});
