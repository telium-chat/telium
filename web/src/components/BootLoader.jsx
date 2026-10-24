import { useId } from 'react';
import { cn } from '../lib/cn.js';

const OUTER = [
  'M 83.099 209.671 A 179 179 0 0 1 302.329 83.099',
  'M 382.572 129.428 A 179 179 0 0 1 424.205 317.222',
  'M 389.023 375.774 A 179 179 0 0 1 85.761 311.314',
];
const INNER = [
  'M 144.494 224.026 A 116 116 0 0 1 264.092 140.283',
  'M 351.022 322.535 A 116 116 0 0 1 268.125 371.365',
];

export function LoaderMark({ className }) {
  const id = useId().replace(/:/g, '');
  const stroke = `url(#${id})`;
  return (
    <svg viewBox="0 0 512 512" fill="none" aria-hidden="true" className={cn('boot-mark', className)}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#C9AEFF" />
          <stop offset="0.36" stopColor="#8B5FE8" />
          <stop offset="0.72" stopColor="#6740C7" />
          <stop offset="1" stopColor="#3F218D" />
        </linearGradient>
      </defs>
      <g transform="translate(-3 0)">
        <g className="boot-mark__outer">
          {OUTER.map((d, i) => (
            <path key={d} d={d} stroke={stroke} strokeWidth="48" strokeLinecap="round" style={{ '--i': i }} />
          ))}
        </g>
        <g className="boot-mark__inner">
          {INNER.map((d, i) => (
            <path key={d} d={d} stroke={stroke} strokeWidth="24" strokeLinecap="round" style={{ '--i': i + 3 }} />
          ))}
        </g>
      </g>
    </svg>
  );
}

export function BootLoader({ label, className }) {
  return (
    <div
      className={cn('boot-loader flex h-full min-h-[100dvh] flex-col items-center justify-center gap-5 bg-background px-5', className)}
      role="status"
      aria-live="polite"
    >
      <LoaderMark className="size-14" />
      {label ? <p className="boot-loader__label text-sm text-muted">{label}</p> : null}
    </div>
  );
}
