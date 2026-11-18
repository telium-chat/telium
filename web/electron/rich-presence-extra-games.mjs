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

/// Sends the same SET_ACTIVITY messages arRPC's own scanner would, on the same 5 second beat, and clears the activity when the game goes away.
export function createExtraGameScanner({
  getProcesses, send, games = EXTRA_GAMES, intervalMs = 5000, now = Date.now,
}) {
  const started = new Map();
  let timer = null;

  const scan = async () => {
    let processes;
    try { processes = await getProcesses(); } catch { return; }
    const found = matchExtraGames(processes, games);
    for (const [id, { pid, game }] of found) {
      if (!started.has(id)) started.set(id, { at: now(), pid });
      send({ socketId: id }, {
        cmd: 'SET_ACTIVITY',
        args: {
          activity: { application_id: id, name: game.name, timestamps: { start: started.get(id).at } },
          pid,
        },
      });
    }
    for (const [id, { pid }] of started) {
      if (found.has(id)) continue;
      started.delete(id);
      send({ socketId: id }, { cmd: 'SET_ACTIVITY', args: { activity: null, pid } });
    }
  };

  return {
    scan,
    start() { if (!timer) { void scan(); timer = setInterval(scan, intervalMs); } },
    stop() { clearInterval(timer); timer = null; },
  };
}
