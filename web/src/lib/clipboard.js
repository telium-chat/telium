
import { toast } from '../hooks/useToast.jsx';
import { t } from './i18n/index.js';

function legacyCopy(value) {
  if (typeof document === 'undefined' || !document.body) return false;
  const input = document.createElement('textarea');
  input.value = String(value ?? '');
  input.readOnly = true;
  input.setAttribute('aria-hidden', 'true');
  input.style.position = 'fixed';
  input.style.inset = '0 auto auto -9999px';
  input.style.opacity = '0';
  document.body.appendChild(input);

  const selection = document.getSelection?.();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i))
    : [];
  const active = document.activeElement;

  input.focus({ preventScroll: true });
  input.select();
  let copied = false;
  try { copied = Boolean(document.execCommand?.('copy')); } catch { copied = false; }
  input.remove();

  try {
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
    active?.focus?.({ preventScroll: true });
  } catch {
    // Restoring focus/selection is polish; the copy result is already known.
  }
  return copied;
}

/// Rewrites the text flavour of a copy so emoji come out as their `alt` (Chrome and Safari drop it). The clone is read through `innerText` so line breaks survive (`textContent` under jsdom). Only the `<img>` is touched, since an animated emoji also draws a canvas. A selection without emoji is left alone. The markup flavour is written too, from the clone before substitution.
export function copyWithEmoji(event) {
  if (typeof document === 'undefined') return;
  const selection = document.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;

  const host = document.createElement('div');
  for (let i = 0; i < selection.rangeCount; i += 1) {
    host.appendChild(selection.getRangeAt(i).cloneContents());
  }
  const images = host.querySelectorAll('img.emoji');
  if (!images.length) return;

  const data = event.clipboardData;
  if (!data) return;

  const html = host.innerHTML;
  for (const image of images) {
    image.replaceWith(document.createTextNode(image.getAttribute('alt') || ''));
  }

  // `innerText` is layout-aware, so the clone must be in the document: off-screen, with its own whitespace.
  host.setAttribute('aria-hidden', 'true');
  host.style.position = 'fixed';
  host.style.inset = '0 auto auto -9999px';
  host.style.whiteSpace = 'pre-wrap';
  document.body.appendChild(host);
  const text = typeof host.innerText === 'string' ? host.innerText : host.textContent;
  host.remove();

  event.preventDefault();
  data.setData('text/plain', text);
  try {
    data.setData('text/html', html);
  } catch {
    // The text is already written; a browser refusing the markup flavour shouldn't also lose the emoji.
  }
}

/// `what` is a translated noun phrase ("Invite link"), never a sentence; the frame is a catalogue pattern so translators control word order and inflection.
export async function copyToClipboard(value, what) {
  const text = String(value ?? '');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast(t('common.copiedThing', { what }));
      return true;
    }
  } catch {
    // Android/Tauri custom origins and privacy modes can deny the modern API but allow a selection copy.
  }

  if (legacyCopy(text)) {
    toast(t('common.copiedThing', { what }));
    return true;
  }
  toast(t('common.clipboardFailed'));
  return false;
}
