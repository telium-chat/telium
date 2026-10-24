import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover } from '@cloudflare/kumo/primitives/popover';
import { cn } from '../lib/cn.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function normaliseHex(text) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(text ?? '').trim());
  if (!match) return null;
  const digits = match[1];
  const full = digits.length === 3
    ? digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2]
    : digits;
  return `#${full.toLowerCase()}`;
}

function hexToHsv(hex) {
  const value = normaliseHex(hex) || '#000000';
  const r = parseInt(value.slice(1, 3), 16) / 255;
  const g = parseInt(value.slice(3, 5), 16) / 255;
  const b = parseInt(value.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  let h = 0;
  if (span > 0) {
    if (max === r) h = ((g - b) / span) % 6;
    else if (max === g) h = (b - r) / span + 2;
    else h = (r - g) / span + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : (span / max) * 100, v: max * 100 };
}

function hsvToHex({ h, s, v }) {
  const chroma = (v / 100) * (s / 100);
  const hue = ((h % 360) + 360) % 360;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = (v / 100) - chroma;
  const [r, g, b] = [
    [chroma, x, 0], [x, chroma, 0], [0, chroma, x],
    [0, x, chroma], [x, 0, chroma], [chroma, 0, x],
  ][Math.floor(hue / 60)];
  const channel = (n) => Math.round((n + base) * 255).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function adopt(hex, previous) {
  const next = hexToHsv(hex);
  return next.s === 0 || next.v === 0 ? { ...next, h: previous.h } : next;
}

const along = (client, start, size) => (size <= 0 ? 0 : clamp((client - start) / size, 0, 1));

function useTrack({ ref, read, disabled, onDrag, onCommit }) {
  const active = useRef(false);

  return {
    onPointerDown(e) {
      if (disabled || e.button > 0) return;
      e.preventDefault();
      active.current = true;
      ref.current?.setPointerCapture?.(e.pointerId);
      ref.current?.focus?.();
      onDrag(read(e));
    },
    onPointerMove(e) {
      if (active.current) onDrag(read(e));
    },
    onPointerUp(e) {
      if (!active.current) return;
      active.current = false;
      ref.current?.releasePointerCapture?.(e.pointerId);
      onCommit(read(e));
    },
    onPointerCancel(e) {
      if (!active.current) return;
      active.current = false;
      onCommit(read(e));
    },
  };
}

export function ColorPicker({
  value,
  onChange,
  fallback = '#5865f2',
  label = 'Choose a colour',
  title,
  className = '',
  children,
  isDisabled = false,
  placement = 'bottom start',
}) {
  const settled = normaliseHex(value) || normaliseHex(fallback) || '#000000';
  const [hsv, setHsv] = useState(() => hexToHsv(settled));
  const [typed, setTyped] = useState(null);

  const held = hsvToHex(hsv);
  const planeRef = useRef(null);
  const hueRef = useRef(null);

  const latest = useRef(hsv);
  latest.current = hsv;

  const emitted = useRef(settled);

  useEffect(() => {
    const next = normaliseHex(value) || normaliseHex(fallback);
    if (!next || next === emitted.current) return;
    emitted.current = next;
    setHsv((previous) => adopt(next, previous));
  }, [value, fallback]);

  const commit = useCallback((hex) => {
    emitted.current = hex;
    onChange?.(hex);
  }, [onChange]);

  const readPlane = useCallback((e) => {
    const rect = planeRef.current?.getBoundingClientRect();
    if (!rect) return { s: 0, v: 0 };
    return {
      s: along(e.clientX, rect.left, rect.width) * 100,
      v: (1 - along(e.clientY, rect.top, rect.height)) * 100,
    };
  }, []);

  const readHue = useCallback((e) => {
    const rect = hueRef.current?.getBoundingClientRect();
    if (!rect) return { h: 0 };
    return { h: along(e.clientX, rect.left, rect.width) * 360 };
  }, []);

  const drag = useCallback((part) => setHsv((previous) => ({ ...previous, ...part })), []);
  const release = useCallback((part) => {
    const next = { ...latest.current, ...part };
    setHsv(next);
    commit(hsvToHex(next));
  }, [commit]);

  const plane = useTrack({
    ref: planeRef, read: readPlane, disabled: isDisabled, onDrag: drag, onCommit: release,
  });

  const hue = useTrack({
    ref: hueRef, read: readHue, disabled: isDisabled, onDrag: drag, onCommit: release,
  });

  const step = (e) => (e.shiftKey ? 10 : 1);

  const settle = (next) => {
    setHsv(next);
    commit(hsvToHex(next));
  };

  const onPlaneKey = (e) => {
    if (isDisabled) return;
    const by = step(e);
    let { s, v } = { s: Math.round(hsv.s), v: Math.round(hsv.v) };
    switch (e.key) {
      case 'ArrowLeft': s -= by; break;
      case 'ArrowRight': s += by; break;
      case 'ArrowUp': v += by; break;
      case 'ArrowDown': v -= by; break;
      case 'Home': s = 0; break;
      case 'End': s = 100; break;
      case 'PageUp': v = 100; break;
      case 'PageDown': v = 0; break;
      default: return;
    }
    e.preventDefault();
    settle({ ...hsv, s: clamp(s, 0, 100), v: clamp(v, 0, 100) });
  };

  const onHueKey = (e) => {
    if (isDisabled) return;
    const by = step(e);
    let h = Math.round(hsv.h);
    switch (e.key) {
      case 'ArrowLeft': case 'ArrowDown': h -= by; break;
      case 'ArrowRight': case 'ArrowUp': h += by; break;
      case 'Home': h = 0; break;
      case 'End': h = 360; break;
      default: return;
    }
    e.preventDefault();
    settle({ ...hsv, h: clamp(h, 0, 360) });
  };

  const onHexChange = (e) => {
    const raw = e.target.value;
    setTyped(raw);
    const hex = normaliseHex(raw);
    if (!hex) return;
    setHsv((previous) => adopt(hex, previous));
    commit(hex);
  };

  const releaseHex = () => setTyped(null);

  const rounded = { h: Math.round(hsv.h), s: Math.round(hsv.s), v: Math.round(hsv.v) };
  const [side = 'bottom', align = 'start'] = String(placement).split(/\s+/);

  return (
    <Popover.Root>
      <Popover.Trigger
        render={<button type="button" />}
        className={cn('color-picker__trigger', className)}
        style={{ '--picker-colour': held }}
        aria-label={label}
        title={title}
        disabled={isDisabled}
      >
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          positionMethod="fixed"
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          className="popover z-50"
        >
          <Popover.Popup
            aria-label={label}
            className="popup popup--panel color-picker"
            style={{ '--picker-colour': held, '--picker-hue': `hsl(${rounded.h} 100% 50%)` }}
          >
            <div
              ref={planeRef}
              role="slider"
              tabIndex={isDisabled ? -1 : 0}
              aria-label="Saturation and brightness"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={rounded.s}
              aria-valuetext={`saturation ${rounded.s}%, brightness ${rounded.v}%, ${held.toUpperCase()}`}
              aria-disabled={isDisabled || undefined}
              className="color-picker__plane"
              onKeyDown={onPlaneKey}
              {...plane}
            >
              <span
                className="color-picker__knob"
                style={{ left: `${rounded.s}%`, top: `${100 - rounded.v}%` }}
              />
            </div>

            <div
              ref={hueRef}
              role="slider"
              tabIndex={isDisabled ? -1 : 0}
              aria-label="Hue"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={360}
              aria-valuenow={rounded.h}
              aria-valuetext={`hue ${rounded.h} degrees`}
              aria-disabled={isDisabled || undefined}
              className="color-picker__hue"
              onKeyDown={onHueKey}
              {...hue}
            >
              <span className="color-picker__knob" style={{ left: `${(rounded.h / 360) * 100}%` }} />
            </div>

            <div className="color-picker__row">
              <span className="color-picker__preview" aria-hidden="true" />
              <input
                type="text"
                className="color-picker__hex"
                value={typed ?? held.toUpperCase()}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                maxLength={7}
                disabled={isDisabled}
                aria-label="Hex colour"
                onChange={onHexChange}
                onBlur={releaseHex}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  releaseHex();
                }}
              />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
