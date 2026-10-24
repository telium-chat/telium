import { useEffect, useRef, useState } from 'react';
import {
  isAndroid,
  isElectronRuntime,
  isNativeShellRuntime,
  isTauriRuntime,
} from '../lib/platform.js';
import { ControlledGifCanvas } from './ControlledGifCanvas.jsx';

const NATIVE_FOCUS_EVENT = 'telium:native-window-focus';
let nativeFocusBridgeStarted = false;
let nativeWindowFocused = null;

function ensureNativeFocusBridge() {
  if (nativeFocusBridgeStarted || !isNativeShellRuntime() || isAndroid || typeof window === 'undefined') return;
  nativeFocusBridgeStarted = true;

  const emit = (focused) => {
    nativeWindowFocused = Boolean(focused);
    window.dispatchEvent(new CustomEvent(NATIVE_FOCUS_EVENT, {
      detail: nativeWindowFocused,
    }));
  };

  if (isElectronRuntime()) {
    try {
      window.teliumDesktop.onWindowFocusChanged(emit);
      // Also query the native window: focus events can precede the first animated image mounting.
      const current = window.teliumDesktop.windowFocus?.();
      if (current && typeof current.then === 'function') {
        current.then(emit).catch(() => {
          emit(typeof document.hasFocus === 'function' ? document.hasFocus() : true);
        });
      } else {
        emit(typeof current === 'boolean'
          ? current
          : (typeof document.hasFocus === 'function' ? document.hasFocus() : true));
      }
    } catch {
      nativeFocusBridgeStarted = false;
      nativeWindowFocused = null;
    }
    return;
  }

  if (!isTauriRuntime()) return;
  import('@tauri-apps/api/window')
    .then(async ({ getCurrentWindow }) => {
      const appWindow = getCurrentWindow();
      await appWindow.onFocusChanged(({ payload }) => emit(payload));
      emit(await appWindow.isFocused());
    })
    .catch(() => {
      nativeFocusBridgeStarted = false;
      nativeWindowFocused = null;
    });
}

function isWindowActive() {
  if (typeof document === 'undefined') return true;
  if (document.hidden) return false;
  if (isNativeShellRuntime() && !isAndroid && nativeWindowFocused !== null) return nativeWindowFocused;
  return typeof document.hasFocus !== 'function' || document.hasFocus();
}

function useWindowActive(track) {
  const [active, setActive] = useState(() => isWindowActive());

  useEffect(() => {
    if (!track || typeof window === 'undefined') return undefined;
    const syncBrowser = () => setActive(isWindowActive());
    const onVisibilityChange = () => setActive(isWindowActive());
    const onNativeFocus = (event) => setActive(Boolean(event.detail));

    window.addEventListener('blur', syncBrowser);
    window.addEventListener('focus', syncBrowser);
    window.addEventListener(NATIVE_FOCUS_EVENT, onNativeFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    ensureNativeFocusBridge();
    syncBrowser();

    return () => {
      window.removeEventListener('blur', syncBrowser);
      window.removeEventListener('focus', syncBrowser);
      window.removeEventListener(NATIVE_FOCUS_EVENT, onNativeFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [track]);

  return active;
}

export function AnimatedImage({
  src, alt = '', className, animated = null, gif = false, onError, onLoad, style, ...props
}) {
  const shouldPause = animated ?? isAnimatedImageSource(src);
  const active = useWindowActive(shouldPause);
  const controlledGif = gif && isNativeShellRuntime() && !isAndroid;

  if (controlledGif) {
    return (
      <ControlledGifCanvas
        src={src}
        active={active}
        alt={alt}
        className={className}
        style={style}
        onError={onError}
        onLoad={onLoad}
        {...props}
      />
    );
  }

  return (
    <SnapshotAnimatedImage
      src={src}
      alt={alt}
      className={className}
      animated={shouldPause}
      active={active}
      onError={onError}
      onLoad={onLoad}
      style={style}
      {...props}
    />
  );
}

function SnapshotAnimatedImage({
  src, alt, className, animated, active, onError, onLoad, style, ...props
}) {
  const imageRef = useRef(null);
  const canvasRef = useRef(null);
  const [frozen, setFrozen] = useState(false);

  useEffect(() => {
    setFrozen(false);
  }, [src]);

  useEffect(() => {
    if (!animated) return;
    if (active) {
      setFrozen(false);
      return;
    }

    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (!image || !canvas || !image.naturalWidth || !image.naturalHeight) return;

    try {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0);
      setFrozen(true);
    } catch {
      // Keep the image visible rather than breaking it
    }
  }, [active, animated]);

  const handleLoad = (event) => {
    onLoad?.(event);
    if (!active && animated) {
      const image = imageRef.current;
      const canvas = canvasRef.current;
      if (!image || !canvas || !image.naturalWidth || !image.naturalHeight) return;
      try {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.drawImage(image, 0, 0);
        setFrozen(true);
      } catch {
        // Same best-effort fallback as above.
      }
    }
  };

  return (
    <>
      <img
        ref={imageRef}
        src={frozen ? undefined : src}
        alt={alt}
        className={className}
        style={frozen ? { ...style, display: 'none' } : style}
        onError={onError}
        onLoad={handleLoad}
        {...props}
      />
      <canvas
        ref={canvasRef}
        role={frozen && alt ? 'img' : undefined}
        aria-label={frozen && alt ? alt : undefined}
        aria-hidden={frozen ? undefined : true}
        className={className}
        style={frozen ? style : { ...style, display: 'none' }}
        title={props.title}
        onClick={props.onClick}
      />
    </>
  );
}

export function isAnimatedImageSource(src) {
  if (!src) return false;
  try {
    const path = new URL(src, typeof document === 'undefined' ? 'http://localhost' : document.baseURI).pathname;
    return /\.(?:gif|webp)$/i.test(path) || /^\/_telium\/v1\/media\/(?!external\/)[^/]+/i.test(path);
  } catch {
    return /\.(?:gif|webp)(?:$|[?#])/i.test(String(src)) || /\/_telium\/v1\/media\/(?!external\/)[^/]+/i.test(String(src));
  }
}

