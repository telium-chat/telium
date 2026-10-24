import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn.js';
import { AnimatedImage } from '../../components/AnimatedImage.jsx';
import { CloseIcon, IconButton } from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';

function wantsNewTab(e) {
  return e.button === 1 || e.metaKey || e.ctrlKey;
}

export function ImagePreview({
  src, alt = null, href = null, onSave = null, onOpenOriginal = null,
  className, imageClassName, onError, animated = null, gif = false,
}) {
  const t = useT();
  const triggerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const caption = alt == null ? t('chat.image.untitled') : alt;

  const zoomLabel = alt
    ? t('chat.image.viewLargerNamed', { label: alt })
    : t('chat.image.viewLarger');

  const original = onOpenOriginal
    || (href ? () => window.open(href, '_blank', 'noopener,noreferrer') : null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={zoomLabel}
        title={zoomLabel}
        onClick={(e) => {
          if (original && wantsNewTab(e)) original();
          else setOpen(true);
        }}
        onAuxClick={original ? (e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          original();
        } : undefined}
        className={cn(
          'block max-w-full cursor-zoom-in appearance-none rounded-xl border-0 bg-transparent p-0 text-start',
          'focus-outside',
          className,
        )}
      >
        <AnimatedImage
          src={src}
          alt={caption}
          animated={animated}
          gif={gif}
          loading="lazy"
          onError={onError}
          className={cn('block max-w-full', imageClassName)}
        />
      </button>
      {open ? (
        <Lightbox
          src={src}
          alt={alt}
          href={href}
          onSave={onSave}
          onOpenOriginal={onOpenOriginal}
          animated={animated}
          gif={gif}
          triggerRef={triggerRef}
          onClosed={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

const EXIT_MS = 200;

const EXIT_HOLD_MS = EXIT_MS + 40;

function reducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function fitInto(frame, natural, intrinsic = true) {
  const width = natural.width || frame.width;
  const height = natural.height || frame.height;
  const scale = intrinsic
    ? Math.min(frame.width / width, frame.height / height, 1)
    : Math.min(frame.width / width, frame.height / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return {
    left: Math.round(frame.left + (frame.width - w) / 2),
    top: Math.round(frame.top + (frame.height - h) / 2),
    width: w,
    height: h,
  };
}

function flipFrom(thumb, target) {
  if (!thumb || thumb.width < 8 || thumb.height < 8) return null;
  const vh = typeof window === 'undefined' ? 0 : window.innerHeight;
  const vw = typeof window === 'undefined' ? 0 : window.innerWidth;
  if (thumb.bottom < 0 || thumb.right < 0 || thumb.top > vh || thumb.left > vw) return null;
  const scale = thumb.width / target.width;
  const dx = (thumb.left + thumb.width / 2) - (target.left + target.width / 2);
  const dy = (thumb.top + thumb.height / 2) - (target.top + target.height / 2);
  return `translate3d(${Math.round(dx)}px, ${Math.round(dy)}px, 0) scale(${scale.toFixed(4)})`;
}

function Lightbox({
  src, alt, href, onSave, onOpenOriginal, animated, gif, triggerRef, onClosed,
}) {
  const t = useT();
  const frameRef = useRef(null);
  const closeWrapRef = useRef(null);
  const exitTimer = useRef(null);
  const [target, setTarget] = useState(null);
  const [phase, setPhase] = useState('enter');
  const [enterFrom, setEnterFrom] = useState(null);
  const [exitTo, setExitTo] = useState(null);

  const naturalOf = useCallback(() => {
    const img = triggerRef.current?.querySelector('img');
    if (img?.naturalWidth && img?.naturalHeight) {
      return { width: img.naturalWidth, height: img.naturalHeight };
    }
    const canvas = triggerRef.current?.querySelector('canvas');
    if (canvas?.width && canvas?.height) {
      return { width: canvas.width, height: canvas.height };
    }
    return null;
  }, [triggerRef]);

  const [natural, setNatural] = useState(naturalOf);

  const measure = useCallback(() => {
    const frame = frameRef.current?.getBoundingClientRect();
    if (!frame || frame.width < 1 || frame.height < 1) return null;
    if (natural) return fitInto(frame, natural);
    const thumb = triggerRef.current?.getBoundingClientRect();
    if (thumb?.width > 0 && thumb?.height > 0) return fitInto(frame, thumb, false);
    return fitInto(frame, frame, false);
  }, [natural, triggerRef]);

  const settle = useCallback(() => {
    setPhase((phase) => (phase === 'enter' ? 'open' : phase));
  }, []);

  const started = useRef(false);
  useLayoutEffect(() => {
    const rect = measure();
    if (!rect) {
      started.current = true;
      settle();
      return undefined;
    }
    setTarget(rect);
    if (reducedMotion()) {
      started.current = true;
      settle();
      return undefined;
    }
    if (!started.current) {
      started.current = true;
      setEnterFrom(flipFrom(triggerRef.current?.getBoundingClientRect(), rect));
    }
    const raf = requestAnimationFrame(() => requestAnimationFrame(settle));
    return () => cancelAnimationFrame(raf);
  }, [measure, triggerRef, settle]);

  useEffect(() => {
    const onResize = () => setTarget((prev) => measure() || prev);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measure]);

  const close = useCallback(() => {
    if (exitTimer.current) return;
    if (reducedMotion()) {
      onClosed();
      return;
    }
    setExitTo(target ? flipFrom(triggerRef.current?.getBoundingClientRect(), target) : null);
    setPhase('exit');
    exitTimer.current = setTimeout(onClosed, EXIT_HOLD_MS);
  }, [onClosed, target, triggerRef]);

  useEffect(() => () => clearTimeout(exitTimer.current), []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [close]);

  useEffect(() => {
    const restore = triggerRef.current;
    closeWrapRef.current?.querySelector('button')?.focus?.();
    return () => restore?.focus?.();
  }, [triggerRef]);

  if (typeof document === 'undefined') return null;

  const stop = (e) => e.stopPropagation();
  const transform = phase === 'open' ? null
    : (phase === 'enter' ? enterFrom : exitTo) || 'scale(0.96)';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || t('chat.image.preview')}
      className="lightbox"
      data-phase={phase}
      onClick={close}
    >
      <div role="document" className="lightbox__scrim" />

      <div ref={frameRef} className="lightbox__frame" aria-hidden="true" />

      <AnimatedImage
        src={src}
        alt={alt}
        animated={animated}
        gif={gif}
        onClick={stop}
        onLoad={(e) => {
          const img = e?.target;
          if (!natural && img?.naturalWidth) {
            setNatural({ width: img.naturalWidth, height: img.naturalHeight });
          }
        }}
        className={cn('lightbox__image', !target && 'lightbox__image--auto')}
        style={target ? {
          left: `${target.left}px`,
          top: `${target.top}px`,
          width: `${target.width}px`,
          height: `${target.height}px`,
          transform,
        } : { transform }}
      />

      <div ref={closeWrapRef} className="lightbox__close">
        <IconButton
          title={t('chat.image.close')}
          onClick={(e) => { stop(e); close(); }}
          className="lightbox__close-button"
        >
          <CloseIcon className="size-5" />
        </IconButton>
      </div>

      <div className="lightbox__bar" onClick={stop}>
        <span className="lightbox__name">{alt || t('chat.image.preview')}</span>
        {onSave ? (
          <button type="button" className="lightbox__action" onClick={onSave}>
            {t('chat.image.save')}
          </button>
        ) : null}
        {onOpenOriginal ? (
          <button type="button" className="lightbox__action" onClick={onOpenOriginal}>
            {t('chat.image.openOriginal')}
          </button>
        ) : href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="lightbox__action"
          >
            {t('chat.image.openOriginal')}
          </a>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
