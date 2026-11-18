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
