import { describe, expect, it, vi } from 'vitest';
import {
  EXTRA_GAMES, createExtraGameScanner, matchExtraGames, pathTails,
} from '../../electron/rich-presence-extra-games.mjs';

const FINALS = 'S:\\steamapps\\common\\The Finals\\Discovery\\Binaries\\Win64\\Discovery-d.exe';

describe('extra game detection', () => {
  it('reads Wine drive paths the way arRPC reads them', () => {
    expect(pathTails(FINALS)).toContain('win64/discovery-d.exe');
  });

  it('recognises THE FINALS as it runs under Proton', () => {
    const found = matchExtraGames([[1, '/usr/bin/bash'], [38042, FINALS]]);
    expect(found.get('1182713227491147776')).toMatchObject({ pid: 38042, game: { name: 'THE FINALS' } });
  });

  it('ignores a binary that only shares a file name suffix', () => {
    expect(matchExtraGames([[1, 'C:\\games\\notwin64\\Discovery-d.exe']]).size).toBe(0);
    expect(matchExtraGames([[1, '/opt/other/launcher']]).size).toBe(0);
  });

  it('starts an activity once the game appears and clears it when it leaves', async () => {
    let list = [[7, FINALS]];
    const send = vi.fn();
    let clock = 1000;
    const scanner = createExtraGameScanner({ getProcesses: async () => list, send, now: () => clock });
    await scanner.scan();
    clock = 2000;
    await scanner.scan();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1].args.activity.timestamps.start).toBe(1000);
    expect(send.mock.calls[0][1].args.activity.name).toBe('THE FINALS');
    list = [];
    await scanner.scan();
    expect(send).toHaveBeenLastCalledWith(
      { socketId: EXTRA_GAMES[0].id },
      { cmd: 'SET_ACTIVITY', args: { activity: null, pid: 7 } },
    );
    await scanner.scan();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('survives a failed process listing', async () => {
    const send = vi.fn();
    const scanner = createExtraGameScanner({ getProcesses: async () => { throw new Error('no /proc'); }, send });
    await expect(scanner.scan()).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('custom programs', () => {
  it('cleans the list and builds games that never carry a Discord id', async () => {
    const { cleanCustomPrograms, customGames } = await import('../../electron/rich-presence-extra-games.mjs');
    const cleaned = cleanCustomPrograms([
      { name: ' Blender ', executable: 'C:\\Apps\\Blender.EXE' },
      { name: 'dupe', executable: 'blender.exe' },
      { name: '', executable: 'x' },
      null,
    ]);
    expect(cleaned).toEqual([{ id: 'custom:blender.exe', name: 'Blender', executable: 'blender.exe' }]);
    expect(customGames(cleaned)[0]).toMatchObject({ custom: true, executables: ['blender.exe'] });
  });

  it('reports a running custom program as a plain named activity and clears it on exit', async () => {
    const { createExtraGameScanner, customGames } = await import('../../electron/rich-presence-extra-games.mjs');
    let processes = [[7, '/usr/bin/blender', []]];
    const custom = [];
    const sent = [];
    const scanner = createExtraGameScanner({
      getProcesses: async () => processes,
      send: (...a) => sent.push(a),
      sendCustom: (d) => custom.push(d),
      games: customGames([{ name: 'Blender', executable: 'blender' }]),
      now: () => 1000,
    });
    await scanner.scan();
    expect(sent).toEqual([]);
    expect(custom[0]).toMatchObject({ source: 'custom-program', pid: 7, activity: { name: 'Blender', type: 0, timestamps: { start: 1000 } } });
    expect(custom[0].activity.application_id).toBeUndefined();
    processes = [];
    await scanner.scan();
    expect(custom[1].activity).toBeNull();
  });
});
