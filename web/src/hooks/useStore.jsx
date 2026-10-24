import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';

const StoreContext = createContext(null);

export function StoreProvider({ store, children }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore called outside a StoreProvider');
  return store;
}

export function useOptionalStore() {
  return useContext(StoreContext);
}

export function useStoreEvent(...events) {
  const store = useStore();
  const [, bump] = useReducer((n) => n + 1, 0);
  const names = events.flat().filter(Boolean);
  const key = names.join('|');
  useEffect(() => {
    const offs = key.split('|').filter(Boolean).map((event) => store.on(event, bump));
    return () => offs.forEach((off) => off());
  }, [store, key]);
}

export function useStoreEventFor(wanted, ...events) {
  const store = useStore();
  const [, bump] = useReducer((n) => n + 1, 0);
  const test = useRef(wanted);
  test.current = wanted;
  const key = events.flat().filter(Boolean).join('|');
  useEffect(() => {
    const offs = key.split('|').filter(Boolean)
      .map((event) => store.on(event, (payload) => { if (test.current(payload)) bump(); }));
    return () => offs.forEach((off) => off());
  }, [store, key]);
}

export function useStoreValue(event, initial = null) {
  const store = useStore();
  const [value, setValue] = useState(initial);
  useEffect(() => store.on(event, setValue), [store, event]);
  return value;
}

export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [generation, setGeneration] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const run = ++latest.current;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve()
      .then(fn)
      .then((data) => { if (run === latest.current) setState({ data, error: null, loading: false }); })
      .catch((error) => { if (run === latest.current) setState({ data: null, error, loading: false }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, generation]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { ...state, reload };
}
