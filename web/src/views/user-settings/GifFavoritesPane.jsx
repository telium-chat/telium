import { useRef, useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { Button, Hint, Section } from '../../components/index.js';
import { toast } from '../../hooks/useToast.jsx';
import {
  gifFavorites, normalizeGifUrl,
} from '../../lib/gifs.js';
import { KEYS, MAX_GIF_FAVORITES } from '../../lib/sync.js';
import { uploadMedia } from '../../lib/upload.js';
import { teliumFetch } from '../../lib/net/transport.js';
import { DISCORD_GIF_EXPORT_SCRIPT } from '../../lib/discordGifExport.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { downloadText } from './RecoveryParts.jsx';

/// Discord numbers favorites upward as they are added, so a bigger `order` is newer; Telium lists newest first, as a
/// new favorite is put at the front. An entry with no `order` keeps its place in the file, after the ones that have one.
function newestFirst(am, ai, bm, bi) {
  const ao = Number(am?.order);
  const bo = Number(bm?.order);
  const a = Number.isFinite(ao);
  const b = Number.isFinite(bo);
  if (a && b) return bo - ao || ai - bi;
  if (a !== b) return a ? -1 : 1;
  return ai - bi;
}

export function discordGifFavoriteUrls(document) {
  const entries = Array.isArray(document)
    ? document.map((url, index) => [url, null, index])
    : document && typeof document === 'object'
      ? Object.entries(document).map(([url, metadata], index) => [url, metadata, index])
      : [];
  return entries
    .map(([url, metadata, index]) => ({
      url: normalizeGifUrl(url),
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      index,
    }))
    .filter((entry) => entry.url)
    .sort((a, b) => newestFirst(a.metadata, a.index, b.metadata, b.index))
    .map(({ url }) => url);
}

export function isDiscordCdnUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== 'cdn.discordapp.com' && host !== 'media.discordapp.net') return false;
    const path = parsed.pathname.toLowerCase();
    return path.startsWith('/attachments/') || path.startsWith('/ephemeral-attachments/');
  } catch {
    return false;
  }
}

export function getCleanDiscordCdnUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (isDiscordCdnUrl(parsed.href)) {
      const params = new URLSearchParams(parsed.search);
      params.delete('format');
      params.delete('animated');
      params.delete('width');
      params.delete('height');
      parsed.search = params.toString() ? `?${params.toString()}` : '';
      return parsed.href;
    }
  } catch {}
  return url;
}

export function extractFilenameFromUrl(url, contentType = '') {
  try {
    const parsed = new URL(url);
    const raw = decodeURIComponent(parsed.pathname.split('/').pop() || 'attachment.gif').split('?')[0];
    const clean = raw.replace(/[^\w.-]/g, '_').trim();
    if (clean && /\.(?:gif|mp4|webp|png|jpe?g)$/i.test(clean)) {
      return clean;
    }
    const ext = contentType.includes('mp4') ? '.mp4' : '.gif';
    return (clean || 'attachment') + ext;
  } catch {
    return 'attachment.gif';
  }
}

export async function rehostDiscordAttachment(home, rawUrl) {
  const cleanUrl = getCleanDiscordCdnUrl(rawUrl);
  let resp = await teliumFetch(cleanUrl, {}, { purpose: 'Discord GIF import' }).catch(() => null);
  if (!resp || !resp.ok) {
    resp = await teliumFetch(rawUrl, {}, { purpose: 'Discord GIF import' });
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} downloading Discord attachment`);
  }
  const blob = await resp.blob();
  const filename = extractFilenameFromUrl(rawUrl, blob.type);
  const file = new File([blob], filename, { type: blob.type || 'image/gif' });
  const uploaded = await uploadMedia(home, file, 'attachment');
  const durableUrl = normalizeGifUrl(uploaded?.url);
  if (!durableUrl) throw new Error('Homeserver returned invalid media URL');
  return durableUrl;
}

export async function processAndRehostFavorites({ document, home, onProgress }) {
  const entries = Array.isArray(document)
    ? document.map((url, index) => ({ key: url, src: url, metadata: {}, index }))
    : document && typeof document === 'object'
      ? Object.entries(document).map(([key, metadata], index) => ({
          key,
          src: metadata?.src || key,
          metadata: metadata && typeof metadata === 'object' ? metadata : {},
          index,
        }))
      : [];

  entries.sort((a, b) => newestFirst(a.metadata, a.index, b.metadata, b.index));

  const finalUrls = [];
  let rehostedCount = 0;
  let externalCount = 0;
  let failedCount = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const targetUrl = entry.src || entry.key;

    if (isDiscordCdnUrl(targetUrl) || isDiscordCdnUrl(entry.key)) {
      onProgress?.(`Re-hosting Discord GIFs (${i + 1} of ${entries.length})…`);
      try {
        const durableUrl = await rehostDiscordAttachment(home, targetUrl);
        if (durableUrl && !finalUrls.includes(durableUrl)) {
          finalUrls.push(durableUrl);
          rehostedCount += 1;
        }
      } catch (err) {
        failedCount += 1;
        console.warn(`[Discord GIF Import] Could not re-host ${targetUrl}:`, err);
        const fallback = normalizeGifUrl(targetUrl);
        if (fallback && !finalUrls.includes(fallback)) {
          finalUrls.push(fallback);
        }
      }
    } else {
      const norm = normalizeGifUrl(entry.key) || normalizeGifUrl(targetUrl);
      if (norm && !finalUrls.includes(norm)) {
        finalUrls.push(norm);
        externalCount += 1;
      }
    }
  }

  return {
    urls: finalUrls,
    rehostedCount,
    externalCount,
    failedCount,
  };
}

export function exportGifFavoritesJson(favorites) {
  const urls = (Array.isArray(favorites) ? favorites : [])
    .map((url) => normalizeGifUrl(url))
    .filter(Boolean);
  return `${JSON.stringify(urls, null, 2)}\n`;
}

export function GifFavoritesPane() {
  const store = useStore();
  useStoreEvent('gif-favorites');
  const jsonInput = useRef(null);
  const filesInput = useRef(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const favorites = gifFavorites(store.sync);
  const copyScript = () => copyToClipboard(DISCORD_GIF_EXPORT_SCRIPT, 'Export script');

  const importFile = async (file) => {
    if (!file) return;
    setBusy(true);
    setProgress('Reading JSON file…');
    try {
      const document = JSON.parse(await file.text());
      const { urls, rehostedCount, externalCount, failedCount } = await processAndRehostFavorites({
        document,
        home: store.home,
        onProgress: setProgress,
      });

      if (!urls.length) throw new Error('No HTTPS GIF URLs were found in that file.');
      const combined = [...favorites, ...urls.filter((url) => !favorites.includes(url))];
      const next = combined.slice(0, MAX_GIF_FAVORITES);
      store.sync.set(KEYS.gifFavorites, next);
      store.emit?.('gif-favorites');

      const added = next.length - favorites.length;
      let msg = `Imported ${added} GIF ${added === 1 ? 'favorite' : 'favorites'}.${rehostedCount > 0 ? ` (${rehostedCount} Discord attachments re-hosted to Telium).` : ''}`;
      if (failedCount > 0) {
        msg += ` (${failedCount} failed to re-host).`;
      }
      if (combined.length > next.length) {
        msg += ` ${combined.length - next.length} did not fit (max ${MAX_GIF_FAVORITES}).`;
      }
      toast(msg);
    } catch (error) {
      toast(error instanceof SyntaxError ? 'That file is not valid JSON.' : (error.message || 'Could not import GIF favorites.'), { error: true });
    } finally {
      setBusy(false);
      setProgress('');
      if (jsonInput.current) jsonInput.current.value = '';
    }
  };

  const uploadFiles = async (files) => {
    if (!files?.length) return;
    setBusy(true);
    let added = 0;
    let failed = 0;
    try {
      const next = [...favorites];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setProgress(`Uploading ${index + 1} of ${files.length}: ${file.name}`);
        try {
          if (!['image/gif', 'video/mp4'].includes(file.type)
            && !/\.(?:gif|mp4)$/i.test(file.name)) {
            throw new Error('Not a GIF or MP4 file');
          }
          const uploaded = await uploadMedia(store.home, file, 'attachment');
          const url = normalizeGifUrl(uploaded.url);
          if (!url) throw new Error('Telium returned an invalid media URL');
          if (!next.includes(url)) {
            if (next.length >= MAX_GIF_FAVORITES) throw new Error(`Favorites limit reached (${MAX_GIF_FAVORITES})`);
            next.push(url);
            added += 1;
          }
        } catch (error) {
          failed += 1;
          console.warn(`[GIF recovery] Could not upload ${file.name}:`, error);
        }
      }
      if (added) {
        store.sync.set(KEYS.gifFavorites, next);
        store.emit?.('gif-favorites');
      }
      toast(`Uploaded ${added} GIF ${added === 1 ? 'favorite' : 'favorites'}.${failed ? ` ${failed} file${failed === 1 ? '' : 's'} failed; see the console for details.` : ''}`);
    } finally {
      setBusy(false);
      setProgress('');
      if (filesInput.current) filesInput.current.value = '';
    }
  };

  const clearAll = () => {
    if (!favorites.length) return;
    if (!window.confirm(`Remove all ${favorites.length} GIF favorites from this account?`)) return;
    store.sync.set(KEYS.gifFavorites, []);
    store.emit?.('gif-favorites');
    toast('All GIF favorites removed.');
  };

  const exportFile = () => {
    if (!favorites.length) return;
    downloadText(`telium-gif-favorites-${Date.now()}.json`, exportGifFavoritesJson(favorites));
    toast(`Exported ${favorites.length} GIF ${favorites.length === 1 ? 'favorite' : 'favorites'}. Send the file to someone and they can import it with "Choose JSON file".`);
  };

  return (
    <details className="ekey-more">
      <summary className="ekey-more__summary">GIF import and management</summary>
      <div className="ekey-more__body">
        <Section title="Import Discord favorites">
          <Hint>
            Export your favorites from Discord's web app, then choose the file here. Expiring Discord CDN attachments are downloaded and re-hosted to your Telium homeserver, while regular links (Tenor/Giphy) are kept.
          </Hint>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Open Discord in a browser (discord.com/app) and log in.</li>
            <li>Press Ctrl+Shift+I (Cmd+Option+I on Mac) and open the Console tab.</li>
            <li>Copy the script below, paste it into the console, and press Enter. If it asks, type "allow pasting" first.</li>
            <li>It saves discord-favorite-gifs-fresh.json. Choose that file here.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={copyScript}>Copy export script</Button>
            <Button disabled={busy} onClick={() => jsonInput.current?.click()}>
              {busy ? (progress || 'Importing…') : 'Choose JSON file'}
            </Button>
          </div>
          <input
            ref={jsonInput}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="Choose GIF favorites JSON file"
            onChange={(event) => importFile(event.target.files?.[0])}
          />
          {progress ? <p role="status" className="text-sm text-muted mt-2">{progress}</p> : null}
        </Section>
        <Section title="Export GIF favorites">
          <Hint>
            {'Download your favorites as a JSON file to back them up or send them to someone. They can import it with "Choose JSON file" above and get the same list.'}
          </Hint>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !favorites.length} onClick={exportFile}>
              Export JSON
            </Button>
          </div>
        </Section>
        <Section title="Upload GIF files and favorite them">
          <Hint>
            {'Select GIF or MP4 files downloaded by the Discord exporter. Telium uploads them to your home server and adds each returned durable media URL to favorites automatically.'}
          </Hint>
          <input
            ref={filesInput}
            type="file"
            accept="image/gif,video/mp4,.gif,.mp4"
            multiple
            className="sr-only"
            aria-label="Choose GIF files to upload in bulk"
            onChange={(event) => uploadFiles(Array.from(event.target.files || []))}
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => filesInput.current?.click()}>
              {busy ? 'Uploading…' : 'Upload GIF files and favorite them'}
            </Button>
            <Button variant="danger-soft" disabled={busy || !favorites.length} onClick={clearAll}>
              Clear all GIF favorites
            </Button>
          </div>
        </Section>
      </div>
    </details>
  );
}
