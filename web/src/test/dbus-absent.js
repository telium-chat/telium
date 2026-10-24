// Vite must resolve the native module; throw so nothing reaches a real session bus.
export default new Proxy({}, {
  get() { throw new Error('the D-Bus binding is not available under test'); },
});
