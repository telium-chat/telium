import { isAndroid, isTauriRuntime } from './platform.js';
import { teliumFetch } from './net/transport.js';

const CHUNK_BYTES = 256 * 1024;

function safeFilename(name) {
  return String(name || 'attachment')
    .replace(/[\\/\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 180) || 'attachment';
}

function toBase64(bytes) {
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

function browserDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

async function androidSave(blob, filename, mime) {
  const bridge = window.teliumAndroidFileBridge;
  if (!bridge?.postMessage || !bridge?.addEventListener) {
    throw new Error(
      'This Android System WebView cannot use Telium’s secure file-save bridge. '
      + 'Update Android System WebView and try again.',
    );
  }

  let waiter = null;
  let destinationReady = false;

  const onMessage = (event) => {
    let message;
    try { message = JSON.parse(String(event.data || '')); } catch { return; }
    if (!waiter) return;
    const current = waiter;
    waiter = null;
    current.resolve(message);
  };

  const nextMessage = () => new Promise((resolve, reject) => {
    if (waiter) {
      reject(new Error('Android file-save protocol received overlapping responses.'));
      return;
    }
    waiter = { resolve, reject };
  });

  const sendJson = async (payload) => {
    const response = nextMessage();
    bridge.postMessage(JSON.stringify(payload));
    const message = await response;
    if (message.op === 'error' || (message.ok === false && message.op !== 'cancelled')) {
      throw new Error(message.message || 'Android could not save the file.');
    }
    return message;
  };

  bridge.addEventListener('message', onMessage);

  try {
    const readyPromise = nextMessage();
    bridge.postMessage(JSON.stringify({
      op: 'begin',
      name: filename,
      mime,
      size: blob.size,
    }));

    const ready = await readyPromise;
    if (ready.op === 'cancelled') return false;
    if (ready.op !== 'ready' || !ready.ok) {
      throw new Error(ready.message || 'Android could not open a save destination.');
    }
    destinationReady = true;

    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const buffer = await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
      const acknowledged = nextMessage();
      if (ready.binary) {
        bridge.postMessage(buffer);
      } else {
        bridge.postMessage(JSON.stringify({
          op: 'chunk64',
          data: toBase64(new Uint8Array(buffer)),
        }));
      }
      const response = await acknowledged;
      if (response.op !== 'chunk' || !response.ok) {
        throw new Error(response.message || 'Android could not write the file.');
      }
    }

    const finished = await sendJson({ op: 'finish' });
    if (finished.op !== 'done' || !finished.ok) {
      throw new Error(finished.message || 'Android could not finish saving the file.');
    }
    return true;
  } catch (error) {
    if (destinationReady) {
      try { bridge.postMessage(JSON.stringify({ op: 'abort' })); } catch { /* bridge already gone */ }
    }
    throw error;
  } finally {
    bridge.removeEventListener?.('message', onMessage);
    if (waiter) {
      waiter.reject(new Error('Android file-save bridge closed before the operation completed.'));
      waiter = null;
    }
  }
}

export async function saveBlob(blob, name, mime = null) {
  if (!(blob instanceof Blob)) throw new TypeError('saveBlob expects a Blob.');
  const filename = safeFilename(name);
  const contentType = mime || blob.type || 'application/octet-stream';

  if (isAndroid && isTauriRuntime()) {
    return androidSave(blob, filename, contentType);
  }
  return browserDownload(blob, filename);
}

export async function saveObjectUrl(url, name, mime = null) {
  if (!url) throw new Error('This attachment is not ready yet.');
  const response = await teliumFetch(url, {}, { purpose: 'save attachment' });
  if (!response.ok) throw new Error(`Could not read the attachment (${response.status}).`);
  return saveBlob(await response.blob(), name, mime);
}
