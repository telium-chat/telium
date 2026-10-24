import { useCallback, useEffect, useRef, useState } from 'react';

export function useLive(fn, { interval = 15_000, deps = [] } = {}) {
  const [state, setState] = useState({ data: null, error: null, at: null, loading: true });
  const call = useRef(fn);
  call.current = fn;

  const run = useCallback(async () => {
    try {
      const data = await call.current();
      setState({ data, error: null, at: Date.now(), loading: false });
    } catch (error) {
      setState((s) => ({ ...s, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    let timer = null;
    let stopped = false;
    const tick = async () => {
      if (typeof document === 'undefined' || !document.hidden) await run();
      if (!stopped) timer = setTimeout(tick, interval);
    };
    tick();
    const wake = () => { if (!document.hidden) run(); };
    document.addEventListener?.('visibilitychange', wake);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener?.('visibilitychange', wake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, interval, ...deps]);

  return { ...state, reload: run };
}

export function useNow(interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}
