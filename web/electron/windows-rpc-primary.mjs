import { createConnection } from 'node:net';

export function discordPipePath(slot) {
  const number = Number(slot);
  if (!Number.isInteger(number) || number < 0 || number > 9) return null;
  return `\\\\?\\pipe\\discord-ipc-${number}`;
}

export function rpcPipeSlot(address) {
  if (typeof address !== 'string') return null;
  const match = address.match(/discord-ipc-(\d+)$/i);
  if (!match) return null;
  const slot = Number(match[1]);
  return Number.isInteger(slot) && slot >= 0 && slot <= 9 ? slot : null;
}

export function pipeOccupied(slot, {
  connect = createConnection,
  timeoutMs = 400,
} = {}) {
  const path = discordPipePath(slot);
  if (!path) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    let timer = null;
    const finish = (occupied) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy?.(); } catch { /* best effort */ }
      resolve(Boolean(occupied));
    };

    try {
      socket = connect(path);
      socket.once?.('connect', () => finish(true));
      socket.once?.('error', () => finish(false));
      timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
    } catch {
      finish(false);
    }
  });
}

export function createWindowsRpcPrimaryPromoter({
  platform = process.platform,
  server,
  createIpc,
  isPipeOccupied = pipeOccupied,
  intervalMs = 15_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onPromoted = () => {},
  onError = () => {},
} = {}) {
  let timer = null;
  let checking = false;
  let stopped = false;

  const currentSlot = () => rpcPipeSlot(server?.ipc?.server?.address?.());

  const check = async () => {
    if (stopped || checking || platform !== 'win32') return false;
    const before = currentSlot();
    if (before === null || before === 0) return false;

    checking = true;
    try {
      if (await isPipeOccupied(0)) return false;

      const next = await createIpc();
      const nextSlot = rpcPipeSlot(next?.server?.address?.());
      if (nextSlot !== 0) {
        try { next?.server?.close?.(); } catch { /* best effort */ }
        return false;
      }

      const previous = server.ipc;
      server.ipc = next;
      try { previous?.server?.close?.(); } catch { /* accepted sockets may outlive the listener */ }
      onPromoted({ from: before, to: 0 });
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      checking = false;
    }
  };

  const start = () => {
    if (platform !== 'win32' || stopped || timer || currentSlot() === 0) return;
    timer = setIntervalFn(() => { void check(); }, intervalMs);
    timer?.unref?.();
  };

  const stop = () => {
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
  };

  return { check, start, stop, currentSlot };
}
