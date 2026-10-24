import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/platform.js', () => ({
  isAndroid: true,
  isTauriRuntime: () => true,
}));

import { saveBlob } from '../lib/download.js';

class FakeAndroidFileBridge {
  constructor({ binary = false } = {}) {
    this.binary = binary;
    this.listeners = new Set();
    this.messages = [];
    this.bytes = 0;
  }

  addEventListener(type, listener) {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === 'message') this.listeners.delete(listener);
  }

  emit(message) {
    queueMicrotask(() => {
      for (const listener of this.listeners) listener({ data: JSON.stringify(message) });
    });
  }

  postMessage(payload) {
    if (payload instanceof ArrayBuffer) {
      this.bytes += payload.byteLength;
      this.messages.push({ op: 'binary', size: payload.byteLength });
      this.emit({ op: 'chunk', ok: true });
      return;
    }

    const message = JSON.parse(payload);
    this.messages.push(message);
    if (message.op === 'begin') {
      this.emit({ op: 'ready', ok: true, binary: this.binary });
    } else if (message.op === 'chunk64') {
      this.bytes += atob(message.data).length;
      this.emit({ op: 'chunk', ok: true });
    } else if (message.op === 'finish') {
      this.emit({ op: 'done', ok: true, name: 'saved.bin', bytes: this.bytes });
    }
  }
}

afterEach(() => {
  delete window.teliumAndroidFileBridge;
});

describe('Android decrypted attachment saving', () => {
  it('streams a blob through the native document bridge in bounded chunks', async () => {
    const bridge = new FakeAndroidFileBridge({ binary: false });
    window.teliumAndroidFileBridge = bridge;

    const bytes = new Uint8Array((256 * 1024 * 2) + 37);
    bytes.fill(7);
    const saved = await saveBlob(
      new Blob([bytes], { type: 'application/octet-stream' }),
      'folder/bad\u0000name.bin',
    );

    expect(saved).toBe(true);
    expect(bridge.bytes).toBe(bytes.byteLength);
    expect(bridge.messages[0]).toMatchObject({
      op: 'begin',
      name: 'folder_bad_name.bin',
      mime: 'application/octet-stream',
      size: bytes.byteLength,
    });
    expect(bridge.messages.filter((message) => message.op === 'chunk64')).toHaveLength(3);
    expect(bridge.messages.at(-1)).toMatchObject({ op: 'finish' });
  });

  it('uses ArrayBuffer chunks when the Android WebView exposes them', async () => {
    const bridge = new FakeAndroidFileBridge({ binary: true });
    window.teliumAndroidFileBridge = bridge;
    const bytes = new Uint8Array(300_000);
    bytes.fill(3);

    expect(await saveBlob(new Blob([bytes]), 'voice-note.bin')).toBe(true);
    expect(bridge.bytes).toBe(bytes.byteLength);
    expect(bridge.messages.some((message) => message.op === 'binary')).toBe(true);
    expect(bridge.messages.some((message) => message.op === 'chunk64')).toBe(false);
  });

  it('treats closing the Android save picker as a cancellation, not an error', async () => {
    const bridge = new FakeAndroidFileBridge();
    bridge.postMessage = function postMessage(payload) {
      const message = JSON.parse(payload);
      this.messages.push(message);
      if (message.op === 'begin') this.emit({ op: 'cancelled', ok: false });
    };
    window.teliumAndroidFileBridge = bridge;

    expect(await saveBlob(new Blob(['secret']), 'secret.txt', 'text/plain')).toBe(false);
    expect(bridge.messages).toHaveLength(1);
  });
});
