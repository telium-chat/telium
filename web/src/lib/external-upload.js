import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, bytes } from './util.js';

/// Gofile is always browser-direct: its bytes must never traverse the homeserver.

export async function uploadExternal(home, host, file, { onProgress, signal } = {}) {
  if (!home?.base || !home?.token || !host?.id) {
    throw new Error('External upload is not configured for this account.');
  }
  if (host.max_file_bytes && file.size > host.max_file_bytes) {
    throw new Error(`${host.name || host.domain} accepts files up to ${bytes(host.max_file_bytes)}`);
  }

  const browserDirect = host.provider === 'gofile' || host.browser_direct === true;
  const result = browserDirect
    ? await uploadBrowserDirect(home, host, file, onProgress, signal)
    : await relayUpload(home, host, file, onProgress, signal);
  const url = new URL(result.url);
  if (url.protocol !== 'https:') throw new Error('External providers must return an HTTPS file URL.');
  const origin = url.host;
  const ref = `external-${b64url(new TextEncoder().encode(url.toString()))}`;
  return {
    external: true,
    external_host: host.id,
    provider: host.provider,
    host: origin,
    origin,
    hash: ref,
    ref,
    reference: url.toString(),
    url: url.toString(),
    filename: file.name,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    expires_at: result.expires_at ?? null,
  };
}

async function uploadBrowserDirect(home, host, file, onProgress, signal) {
  if (host.provider !== 'gofile') {
    throw new Error(`Unsupported browser-direct upload provider: ${host.provider || 'unknown'}`);
  }
  const form = new FormData();
  form.append('file', file, file.name);
  const payload = await multipart(host.upload_url, form, onProgress, true, file.size, signal);
  const data = payload?.data || payload;
  const direct = data?.directLink || data?.direct_link;
  if (direct && /^https:\/\//i.test(direct)) return { url: direct };

  // The server/id pair isn't playable (old /download/{id} redirects); resolve the direct file URL.
  return { url: await resolveGofileFileLink(home, data, file) };
}

let gofileWebsiteTokenScript;

async function resolveGofileFileLink(home, data, file) {
  const page = data?.downloadPage || data?.download_page;
  const token = data?.guestToken || data?.guest_token || data?.token;
  if (!page || !token) throw new Error('Gofile returned no public file session metadata.');

  let pageUrl;
  try { pageUrl = new URL(page); } catch { throw new Error('Gofile returned an invalid download page.'); }
  if (pageUrl.protocol !== 'https:' || !['gofile.io', 'www.gofile.io'].includes(pageUrl.hostname)) {
    throw new Error('Gofile returned an unrecognised download page.');
  }
  const parts = pageUrl.pathname.split('/').filter(Boolean);
  const code = parts[0] === 'd' ? parts[1] : null;
  if (!code) throw new Error('Gofile returned an unrecognised download page.');

  let websiteToken;
  try {
    websiteToken = await getInitialGofileWebsiteToken(token);
  } catch (error) {
    throw new Error(`Gofile direct-link lookup could not create its session metadata: ${error.message}`);
  }
  let { response, payload } = await resolveGofileContents(home, {
    page,
    token,
    websiteToken,
    fileId: data?.id || data?.fileId,
    filename: data?.name || data?.fileName || file.name,
  });
  // If Gofile rotated its public secret, refresh the script once and retry.
  const serverMessage = payload?.message || '';
  if (response.status === 401 || response.status === 403 || /Gofile file lookup failed \((401|403)/.test(serverMessage)) {
    try {
      const refreshedToken = await loadGofileWebsiteToken(token);
      if (refreshedToken && refreshedToken !== websiteToken) {
        ({ response, payload } = await resolveGofileContents(home, {
          page,
          token,
          websiteToken: refreshedToken,
          fileId: data?.id || data?.fileId,
          filename: data?.name || data?.fileName || file.name,
        }));
      }
    } catch (error) {
      throw new Error(`Gofile direct-link lookup could not refresh its session metadata: ${error.message}`);
    }
  }
  if (!response.ok) {
    const detail = payload?.data?.message || payload?.message;
    throw new Error(detail ? `Gofile direct-link lookup failed: ${detail}` : `Gofile direct-link lookup failed (${response.status}).`);
  }

  const url = payload?.url;
  if (!url || !/^https:\/\//i.test(url)) {
    throw new Error('Gofile did not return a direct file URL.');
  }
  return url;
}

async function getInitialGofileWebsiteToken(accountToken) {
  const generate = globalThis.generateWT;
  if (typeof generate === 'function') return generate(accountToken);
  return generateGofileWebsiteTokenLocally(accountToken);
}

async function generateGofileWebsiteTokenLocally(accountToken) {
  const timestamp = Math.floor(Date.now() / 1000 / 0x3840).toString();
  const input = [
    navigator.userAgent,
    navigator.language || '',
    accountToken,
    timestamp,
    '12af056dacea0b',
  ].join('::');
  return [...sha256(new TextEncoder().encode(input))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function resolveGofileContents(home, { page, token, websiteToken, fileId, filename }) {
  const url = `${home.base.replace(/\/$/, '')}/_telium/v1/media/external/gofile/resolve`;
  let response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${home.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        download_page: page,
        guest_token: token,
        website_token: websiteToken,
        browser_language: navigator.language || '',
        browser_user_agent: navigator.userAgent || '',
        file_id: fileId,
        filename,
      }),
    }, 25000);
  } catch {
    throw new Error('Gofile direct-link lookup could not reach the home server.');
  }
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  return { response, payload };
}

async function loadGofileWebsiteToken(accountToken) {
  const generate = globalThis.generateWT;
  if (typeof generate === 'function') return generate(accountToken);
  if (typeof document === 'undefined') {
    throw new Error('Gofile website token generator is unavailable.');
  }
  if (!gofileWebsiteTokenScript) {
    gofileWebsiteTokenScript = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = setTimeout(() => {
        script.remove?.();
        reject(new Error('requesting wt.obf.js timed out'));
      }, 4000);
      script.src = 'https://gofile.io/js/wt.obf.js';
      script.async = true;
      script.onload = () => {
        clearTimeout(timeout);
        typeof globalThis.generateWT === 'function'
          ? resolve()
          : reject(new Error('Gofile website token generator is unavailable.'));
      };
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Gofile website token generator could not load.'));
      };
      document.head.appendChild(script);
    }).catch((error) => {
      gofileWebsiteTokenScript = null;
      throw error;
    });
  }
  await gofileWebsiteTokenScript;
  return globalThis.generateWT(accountToken);
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function relayUpload(home, host, file, onProgress, signal) {
  const url = `${home.base.replace(/\/$/, '')}/_telium/v1/media/external/${encodeURIComponent(host.id)}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${home.token}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-Telium-Filename', encodeURIComponent(file.name));
    const onAbort = () => xhr.abort();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    };
    xhr.onabort = () => reject(new DOMException('The upload was cancelled.', 'AbortError'));
    xhr.onerror = () => reject(new Error('External upload relay failed.'));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let message = 'External upload failed.';
        try { message = JSON.parse(xhr.responseText).message || message; } catch { /* text response */ }
        reject(new Error(message));
        return;
      }
      try {
        const result = JSON.parse(xhr.responseText);
        if (!result?.url) throw new Error('Home server returned no external file URL.');
        resolve(result);
      } catch {
        reject(new Error('External upload relay returned malformed JSON.'));
      }
    };
    xhr.send(file);
  });
}

function multipart(url, form, onProgress, json = false, fileSize = 0, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    const onAbort = () => xhr.abort();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    onProgress?.(0, fileSize || 0);
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : fileSize;
      if (!total) return;
      onProgress?.(Math.min(event.loaded, total), total);
    };
    xhr.onabort = () => reject(new DOMException('The upload was cancelled.', 'AbortError'));
    xhr.onerror = () => reject(new Error('External upload failed.'));
    xhr.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      if (xhr.status < 200 || xhr.status >= 300) {
        let message = 'External upload failed.';
        try { message = JSON.parse(xhr.responseText).message || message; } catch { /* text response */ }
        reject(new Error(message));
        return;
      }
      if (fileSize) onProgress?.(fileSize, fileSize);
      try {
        resolve(json ? JSON.parse(xhr.responseText) : xhr.responseText);
      } catch {
        reject(new Error('External provider returned malformed JSON.'));
      }
    };
    xhr.send(form);
  });
}
