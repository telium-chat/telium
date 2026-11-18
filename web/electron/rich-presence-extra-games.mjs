// Games arRPC's bundled detection list misses. arRPC (and Discord) match a running process by the tail of its path against `executables` in detectable.json, so a game whose Steam/Proton build runs a differently named binary is never seen. Each entry here reuses the application id already in that list and only adds the executable to look for.
//
// THE FINALS: Discord's list has `win64/discovery.exe` and `wingdk/discovery-d.exe`, but the Steam build under Proton runs `...\The Finals\Discovery\Binaries\Win64\Discovery-d.exe`, which matches neither.
export const EXTRA_GAMES = [
  { id: '1182713227491147776', name: 'THE FINALS', executables: ['win64/discovery-d.exe'] },
];

/// The path tails arRPC compares: every trailing run of segments, lower-cased with `\` read as `/`.
export function pathTails(path) {
  const parts = String(path || '').toLowerCase().replaceAll('\\', '/').split('/');
  const tails = [];
  for (let i = 1; i < parts.length + 1; i += 1) tails.push(parts.slice(-i).join('/'));
  return tails;
}

/// Ids of the extra games present among `processes` ([pid, path, args] rows), with the pid that matched.
export function matchExtraGames(processes, games = EXTRA_GAMES) {
  const found = new Map();
  for (const [pid, path] of processes) {
    if (!path) continue;
    const tails = pathTails(path);
    for (const game of games) {
      if (found.has(game.id)) continue;
      if (game.executables.some((exe) => tails.includes(exe))) found.set(game.id, { pid, game });
    }
  }
  return found;
}

/// Sends the same SET_ACTIVITY messages arRPC's own scanner would, on the same 5 second beat, and clears the activity when the game goes away. A `custom` entry (a program the user picked by hand) has no Discord application behind it, so it goes to `sendCustom` as a plain named activity instead, and nothing about it is ever looked up.
export function createExtraGameScanner({
  getProcesses, send, sendCustom = null, games = EXTRA_GAMES, intervalMs = 5000, now = Date.now,
}) {
  const started = new Map();
  let timer = null;
  let current = games;

  const deliver = (game, pid, activity) => {
    if (game.custom) {
      sendCustom?.({ source: 'custom-program', socketId: game.id, pid, activity });
    } else {
      send({ socketId: game.id }, { cmd: 'SET_ACTIVITY', args: { activity, pid } });
    }
  };

  const scan = async () => {
    let processes;
    try { processes = await getProcesses(); } catch { return; }
    const found = matchExtraGames(processes, current);
    for (const [id, { pid, game }] of found) {
      if (!started.has(id)) started.set(id, { at: now(), pid, game });
      const timestamps = { start: started.get(id).at };
      deliver(game, pid, game.custom
        ? { name: game.name, type: 0, timestamps }
        : { application_id: id, name: game.name, timestamps });
    }
    for (const [id, { pid, game }] of started) {
      if (found.has(id)) continue;
      started.delete(id);
      deliver(game, pid, null);
    }
  };

  return {
    scan,
    /// Swaps the list of programs to look for; one that was running and is no longer listed is cleared on the next scan.
    setGames(next) { current = next; void scan(); },
    start() { if (!timer) { void scan(); timer = setInterval(scan, intervalMs); } },
    stop() { clearInterval(timer); timer = null; },
  };
}

/// What the main process and the picker send: a list of `{ id, name, executable }`, cleaned and bounded. The executable is the last path segment, lower-cased, so it matches however the program was launched (including a Windows path under Proton).
export const MAX_CUSTOM_PROGRAMS = 20;

export function cleanCustomPrograms(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const executable = String(raw?.executable ?? '').toLowerCase().replaceAll('\\', '/').split('/').pop().trim();
    const name = String(raw?.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
    if (!executable || executable.length > 128 || !name || seen.has(executable)) continue;
    seen.add(executable);
    out.push({ id: `custom:${executable}`, name, executable });
    if (out.length >= MAX_CUSTOM_PROGRAMS) break;
  }
  return out;
}

export function customGames(programs) {
  return cleanCustomPrograms(programs).map((p) => ({
    id: p.id, name: p.name, executables: [p.executable], custom: true,
  }));
}
