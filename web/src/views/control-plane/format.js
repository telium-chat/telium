import { bytes as formatBytes } from '../../lib/util.js';

export const ABSENT = '—';

export const present = (v) => v !== null && v !== undefined;

export function count(n) {
  if (!present(n)) return ABSENT;
  return Number(n).toLocaleString();
}

export function size(n) {
  if (!present(n)) return ABSENT;
  return formatBytes(Number(n));
}

export function millis(ms) {
  if (!present(ms)) return ABSENT;
  const n = Number(ms);
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s`;
  if (n >= 10) return `${Math.round(n)}ms`;
  return `${n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}ms`;
}

export function duration(ms) {
  if (!present(ms)) return ABSENT;
  const n = Math.max(0, Number(ms));
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function rate(n, coveredMs) {
  if (!present(n) || !coveredMs) return ABSENT;
  const per = (Number(n) * 1000) / coveredMs;
  if (per >= 100) return `${Math.round(per)}/s`;
  if (per >= 1) return `${per.toFixed(1)}/s`;
  if (per >= 0.01) return `${(per * 60).toFixed(per * 60 >= 10 ? 0 : 1)}/min`;
  return per === 0 ? '0/s' : '<0.01/s';
}

export function share(part, whole) {
  if (!present(part) || !whole) return ABSENT;
  const pct = (Number(part) / Number(whole)) * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
}

export function clock(ms, withDay = false) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!withDay) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}
