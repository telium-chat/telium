import { useEffect, useRef, useState } from 'react';
import { useModal } from '../../hooks/useModal.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import {
  PRESETS, ZOOM, clampCrop, cropRect, isAnimated, isAnimatedGif, reencode,
  reencodeAnimatedGif,
} from '../../lib/image.js';
import { Button, Field, ImageIcon, ModalShell, Notice, TextInput } from '../../components/index.js';

const NUDGE = 0.04;

const SHAPES = { avatar: 'circle', icon: 'squircle', banner: 'wide' };

export function CropImageDialog({ file, preset, kind, title, onDone, close }) {
  const namesExpression = kind === 'emoji' || kind === 'sticker';
  const aspect = preset?.aspect || 1;
  const shape = SHAPES[kind] || 'square';
  const [url, setUrl] = useState(null);
  const [source, setSource] = useState(null);
  const [crop, setCrop] = useState({ zoom: 1, cx: 0.5, cy: 0.5 });
  const [name, setName] = useState(() => namesExpression
    ? expressionName(file.name.replace(/\.[^.]+$/, ''))
    : '');
  const [animated, setAnimated] = useState(false);
  const [animatedGif, setAnimatedGif] = useState(false);
  const [busy, setBusy] = useState(false);
  const stage = useRef(null);
  const frame = useRef(null);
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const settled = useRef(false);
  const lifecycle = useRef(0);

  const settle = (value) => {
    if (settled.current) return;
    settled.current = true;
    onDone(value);
  };

  // Create in the effect: StrictMode would revoke a blob the second pass still shows.
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  useEffect(() => {
    // StrictMode simulates cleanup; defer so a real dismissal still resolves as cancelled.
    const generation = ++lifecycle.current;
    return () => {
      Promise.resolve().then(() => {
        if (lifecycle.current === generation) settle(null);
      });
    };
  }, []);

  useEffect(() => {
    let live = true;
    file.arrayBuffer().then((buf) => {
      if (!live) return;
      setAnimated(isAnimated(buf));
      setAnimatedGif(isAnimatedGif(buf));
    }).catch(() => {});
    return () => { live = false; };
  }, [file]);

  const cropSpan = (zoom) => Math.min(source.width, source.height * aspect) / clampZoom(zoom);

  const frameWidth = () => frame.current?.getBoundingClientRect().width || 0;

  const anchorAt = (clientX, clientY) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return null;
    return { x: clientX - (box.left + box.width / 2), y: clientY - (box.top + box.height / 2) };
  };

  const commit = (next) => setCrop((c) => clampCrop(
    source.width, source.height, { ...c, ...next(c) }, aspect,
  ));

  const panBy = (dx, dy) => {
    const width = frameWidth();
    if (!source || !width) return;
    commit((c) => {
      const perPixel = cropSpan(c.zoom) / width;
      return {
        cx: c.cx - (dx * perPixel) / source.width,
        cy: c.cy - (dy * perPixel) / source.height,
      };
    });
  };

  const zoomTo = (next, anchor) => {
    if (!source) return;
    const width = frameWidth();
    commit((c) => {
      const zoom = clampZoom(typeof next === 'function' ? next(c.zoom) : next);
      const drift = anchor && width ? (cropSpan(c.zoom) - cropSpan(zoom)) / width : 0;
      return {
        zoom,
        cx: c.cx + ((anchor?.x || 0) * drift) / source.width,
        cy: c.cy + ((anchor?.y || 0) * drift) / source.height,
      };
    });
  };

  const nudge = (dx, dy) => {
    if (!source) return;
    commit((c) => {
      const span = cropSpan(c.zoom);
      return {
        cx: c.cx - (dx * NUDGE * span) / source.width,
        cy: c.cy - (dy * NUDGE * (span / aspect)) / source.height,
      };
    });
  };

  const onKeyDown = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) { e.preventDefault(); nudge(...arrows[e.key]); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo((z) => z + ZOOM.step * 5); }
    else if (e.key === '-') { e.preventDefault(); zoomTo((z) => z - ZOOM.step * 5); }
  };

  useEffect(() => {
    const node = stage.current;
    if (!node || !source) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const lines = e.deltaMode === 1 ? 16 : 1;
      const travel = e.deltaY * lines * (e.ctrlKey ? 0.01 : 0.0025);
      zoomTo((z) => z * Math.exp(-travel), anchorAt(e.clientX, e.clientY));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [source, aspect]);

  const midpoint = () => {
    const [a, b] = [...pointers.current.values()];
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      spread: Math.hypot(b.x - a.x, b.y - a.y),
    };
  };

  const retarget = () => {
    const points = [...pointers.current.values()];
    if (points.length >= 2) gesture.current = { kind: 'pinch', ...midpoint() };
    else if (points.length === 1) gesture.current = { kind: 'pan', x: points[0].x, y: points[0].y };
    else gesture.current = null;
  };

  const onPointerDown = (e) => {
    if (!source) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    retarget();
  };

  const onPointerMove = (e) => {
    if (!source || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const active = gesture.current;
    if (!active) return;

    if (active.kind === 'pinch') {
      if (pointers.current.size < 2) return;
      const now = midpoint();
      panBy(now.x - active.x, now.y - active.y);
      if (active.spread > 0 && now.spread > 0) {
        zoomTo((z) => z * (now.spread / active.spread), anchorAt(now.x, now.y));
      }
      gesture.current = { kind: 'pinch', ...now };
      return;
    }

    panBy(e.clientX - active.x, e.clientY - active.y);
    gesture.current = { kind: 'pan', x: e.clientX, y: e.clientY };
  };

  const endPointer = (e) => {
    pointers.current.delete(e.pointerId);
    retarget();
  };

  const finish = async (original) => {
    setBusy(true);
    try {
      const output = original
        ? (animatedGif ? await reencodeAnimatedGif(file, crop, preset) : file)
        : await reencode(file, crop, preset);
      if (output.size > preset.maxBytes) {
        throw new Error(`this image has to be under ${Math.round(preset.maxBytes / 1024)} KB, `
          + `and the processed file is ${Math.round(output.size / 1024)} KB`);
      }
      settle(namesExpression ? namedExpression(output, name) : output);
      close();
    } catch (e) {
      reportError(e, 'Could not process this image');
      setBusy(false);
    }
  };

  const zoom = clampZoom(crop.zoom);

  return (
    <ModalShell
      title={title}
      footer={(
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          {animated ? (
            <Button variant="secondary" disabled={busy} onClick={() => finish(true)}>
              {animatedGif ? 'Keep animation (WebP)' : 'Keep animation'}
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={busy || !source || (namesExpression && !name)}
            onClick={() => finish(false)}
          >
            {busy ? 'Processing…' : 'Use image'}
          </Button>
        </>
      )}
    >
      {animated ? (
        <Notice tone="warn">
          {animatedGif
            ? 'This image is animated. “Use image” keeps the first frame only; '
              + '“Keep animation” crops and compresses it as an animated WebP.'
            : 'This image is animated. Cropping it keeps the first frame only — '
              + 'use “Keep animation” to upload it unchanged instead.'}
        </Notice>
      ) : null}

      {namesExpression ? (
        <Field
          label={kind === 'emoji' ? 'Emoji name' : 'Sticker name'}
          hint="1–32 lowercase letters, numbers, dots, underscores, or hyphens."
        >
          <TextInput
            value={name}
            aria-label={kind === 'emoji' ? 'Emoji name' : 'Sticker name'}
            placeholder="e.g. party_blob"
            maxLength={32}
            onChange={(e) => setName(expressionName(e.target.value))}
          />
        </Field>
      ) : null}

      <div
        ref={stage}
        role="group"
        tabIndex={0}
        aria-label="Crop area. Drag to reposition, arrow keys to move, plus and minus to zoom."
        className="crop-stage"
        data-shape={shape}
        data-ready={source ? 'true' : 'false'}
        style={{ '--crop-aspect': String(aspect) }}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        <div ref={frame} className="crop-frame">
          {url ? (
            <img
              src={url}
              alt=""
              draggable={false}
              className="crop-image"
              style={source ? imageStyle(source, crop, aspect) : { visibility: 'hidden' }}
              onLoad={(e) => setSource({
                width: e.target.naturalWidth,
                height: e.target.naturalHeight,
              })}
            />
          ) : null}
          <div className="crop-window" />
        </div>
      </div>

      <div className="crop-zoom">
        <ImageIcon className="crop-zoom__mark size-3.5" />
        <input
          type="range"
          className="crop-zoom__slider"
          aria-label="Zoom"
          min={ZOOM.min}
          max={ZOOM.max}
          step={ZOOM.step}
          value={zoom}
          disabled={!source}
          style={{ '--crop-zoom-fill': `${((zoom - ZOOM.min) / (ZOOM.max - ZOOM.min)) * 100}%` }}
          onChange={(e) => zoomTo(Number(e.target.value))}
        />
        <ImageIcon className="crop-zoom__mark size-5" />
      </div>
    </ModalShell>
  );
}

function imageStyle(source, crop, aspect) {
  const rect = cropRect(source.width, source.height, crop, aspect);
  const width = rect.width || rect.side;
  const height = rect.height || rect.side;
  return {
    width: `${(source.width / width) * 100}%`,
    height: `${(source.height / height) * 100}%`,
    translate: `${(-rect.sx / source.width) * 100}% ${(-rect.sy / source.height) * 100}%`,
  };
}

function clampZoom(value) {
  return Math.min(ZOOM.max, Math.max(ZOOM.min, Number.isFinite(value) ? value : ZOOM.min));
}

export function useImageCrop() {
  const modal = useModal();
  return (file, kind) => new Promise((resolve) => {
    modal.open((close) => (
      <CropImageDialog
        file={file}
        preset={PRESETS[kind]}
        kind={kind}
        title={{
          emoji: 'Crop this emoji',
          sticker: 'Crop this sticker',
          icon: 'Crop this icon',
          banner: 'Crop your profile banner',
        }[kind] || 'Crop your avatar'}
        onDone={resolve}
        close={close}
      />
    ), { wide: true });
  });
}

function expressionName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
}

function namedExpression(file, name) {
  const extension = file.name.match(/\.[^.]+$/)?.[0] || '.png';
  return new File([file], `${name}${extension}`, { type: file.type, lastModified: file.lastModified });
}
