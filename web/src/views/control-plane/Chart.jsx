import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { ABSENT, clock, present } from './format.js';

function useWidth(ref, fallback = 720) {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

const TONES = {
  accent: 'text-accent',
  danger: 'text-danger',
  success: 'text-success',
  warning: 'text-warning',
  muted: 'text-muted',
  foreground: 'text-foreground',
};

function ceiling(max) {
  if (!(max > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].find((s) => max <= s * magnitude) ?? 10;
  return step * magnitude;
}

function pathOf(values, x, y) {
  let d = '';
  let open = false;
  values.forEach((v, i) => {
    if (!present(v)) { open = false; return; }
    d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    open = true;
  });
  return d;
}

function areaOf(values, x, y, floor) {
  let d = '';
  let run = [];
  const flush = () => {
    if (run.length) {
      d += `M${x(run[0]).toFixed(1)} ${floor.toFixed(1)}`;
      run.forEach((i) => { d += `L${x(i).toFixed(1)} ${y(values[i]).toFixed(1)}`; });
      d += `L${x(run[run.length - 1]).toFixed(1)} ${floor.toFixed(1)}Z`;
    }
    run = [];
  };
  values.forEach((v, i) => { if (present(v)) run.push(i); else flush(); });
  flush();
  return d;
}

export function TimeChart({
  points, series, height = 148, format = (v) => String(v), label, className,
}) {
  const box = useRef(null);
  const width = useWidth(box);
  const [at, setAt] = useState(null);

  const columns = points.length;
  const values = series.map((s) => points.map((p) => {
    const v = s.value(p);
    return present(v) ? Number(v) : null;
  }));
  const measured = values.flat().filter(present);
  const top = ceiling(Math.max(0, ...measured));

  const pad = { top: 10, right: 2, bottom: 2, left: 2 };
  const plotH = height - pad.top - pad.bottom;
  const x = (i) => (columns < 2
    ? width / 2
    : pad.left + ((width - pad.left - pad.right) * i) / (columns - 1));
  const y = (v) => pad.top + plotH - (plotH * Math.min(v, top)) / top;
  const floor = pad.top + plotH;

  if (!measured.length) {
    return (
      <div
        ref={box}
        className={cn('cp-chart cp-chart--empty', className)}
        style={{ height: `${height}px` }}
      >
        <span className="text-xs text-muted">Not measured in this window</span>
      </div>
    );
  }

  const hovered = at !== null && at >= 0 && at < columns ? at : null;

  return (
    <div className={cn('cp-chart', className)}>
      <div className="cp-chart__head">
        <div className="cp-chart__legend">
          {series.map((s, si) => (
            <span key={s.key} className={cn('cp-chart__key', TONES[s.tone] || TONES.accent)}>
              <span aria-hidden="true" className="cp-chart__swatch" />
              <span className="text-muted">{s.label}</span>
              {hovered !== null ? (
                <span className="tnum text-foreground">
                  {present(values[si][hovered]) ? format(values[si][hovered]) : ABSENT}
                </span>
              ) : null}
            </span>
          ))}
        </div>
        <span className="cp-chart__when tnum">
          {hovered !== null
            ? clock(points[hovered].start, columns > 1
              && points[columns - 1].end - points[0].start > 36 * 3600 * 1000)
            : format(top)}
        </span>
      </div>
      <div
        ref={box}
        className="cp-chart__plot"
        style={{ height: `${height}px` }}
        onPointerLeave={() => setAt(null)}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
          setAt(Math.round(ratio * (columns - 1)));
        }}
      >
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={label || series.map((s) => s.label).join(', ')}
        >
          <line
            x1={0}
            y1={floor + 0.5}
            x2={width}
            y2={floor + 0.5}
            className="text-separator"
            stroke="currentColor"
            strokeWidth="1"
          />
          {series.map((s, si) => (
            <g key={s.key} className={TONES[s.tone] || TONES.accent}>
              {s.kind === 'area' ? (
                <path d={areaOf(values[si], x, y, floor)} fill="currentColor" opacity="0.16" />
              ) : null}
              <path
                d={pathOf(values[si], x, y)}
                fill="none"
                stroke="currentColor"
                strokeWidth={s.kind === 'area' ? 1.5 : 1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          ))}
          {hovered !== null ? (
            <g>
              <line
                x1={x(hovered)}
                y1={pad.top - 6}
                x2={x(hovered)}
                y2={floor}
                className="text-muted"
                stroke="currentColor"
                strokeWidth="1"
                opacity="0.45"
              />
              {series.map((s, si) => (present(values[si][hovered]) ? (
                <circle
                  key={s.key}
                  cx={x(hovered)}
                  cy={y(values[si][hovered])}
                  r="2.75"
                  className={TONES[s.tone] || TONES.accent}
                  fill="currentColor"
                />
              ) : null))}
            </g>
          ) : null}
        </svg>
      </div>
    </div>
  );
}

export function Sparkline({ points, value, tone = 'accent', height = 30 }) {
  const box = useRef(null);
  const width = useWidth(box, 120);
  const values = points.map((p) => {
    const v = value(p);
    return present(v) ? Number(v) : null;
  });
  const measured = values.filter(present);
  if (measured.length < 2) return <div ref={box} style={{ height: `${height}px` }} />;
  const top = ceiling(Math.max(...measured));
  const x = (i) => (width * i) / Math.max(1, values.length - 1);
  const y = (v) => height - 2 - ((height - 4) * Math.min(v, top)) / top;
  return (
    <div ref={box} className="cp-spark" style={{ height: `${height}px` }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <g className={TONES[tone] || TONES.accent}>
          <path d={areaOf(values, x, y, height)} fill="currentColor" opacity="0.14" />
          <path
            d={pathOf(values, x, y)}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    </div>
  );
}

export function Meter({ rows, format = (v) => String(v), tone = 'accent' }) {
  const top = Math.max(1, ...rows.map((r) => r.value || 0));
  return (
    <div className="cp-meters">
      {rows.map((row) => (
        <div key={row.label} className="cp-meter">
          <span className="cp-meter__label truncate" title={row.label}>{row.label}</span>
          <span className="cp-meter__track">
            <span
              className={cn('cp-meter__fill', TONES[row.tone || tone] || TONES.accent)}
              style={{ width: `${Math.max(2, (100 * (row.value || 0)) / top)}%` }}
            />
          </span>
          <span className="cp-meter__value tnum">{format(row.value)}</span>
        </div>
      ))}
    </div>
  );
}
