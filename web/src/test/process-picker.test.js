import { describe, expect, it } from 'vitest';
import { friendlyName, pickableProcesses } from '../lib/process-picker.js';
import { addCustomProgram, customPrograms, removeCustomProgram } from '../lib/rich-presence.js';

const row = (executable, path = `/home/me/${executable}`) => ({ executable, path, count: 1 });

describe('friendlyName', () => {
  it('turns an executable into a readable starting name', () => {
    expect(friendlyName('discovery-d.exe')).toBe('Discovery D');
    expect(friendlyName('my_tool')).toBe('My Tool');
    expect(friendlyName('OBS.exe')).toBe('OBS');
    expect(friendlyName('S:\\Games\\Blender\\blender.exe')).toBe('Blender');
  });
});

describe('pickableProcesses', () => {
  const rows = [row('zed'), row('Blender'), row('systemd', '/usr/lib/systemd/systemd'), row('electron'), row('cmd.exe', 'C:\\Windows\\System32\\cmd.exe')];
  it('hides system plumbing and Telium itself, and sorts by name', () => {
    expect(pickableProcesses(rows).map((r) => r.executable)).toEqual(['Blender', 'zed']);
  });
  it('hides what is already added and filters by query', () => {
    expect(pickableProcesses(rows, { listed: [{ executable: 'zed' }] }).map((r) => r.executable)).toEqual(['Blender']);
    expect(pickableProcesses(rows, { query: 'blen' }).map((r) => r.executable)).toEqual(['Blender']);
  });
  it('tolerates garbage', () => {
    expect(pickableProcesses(null)).toEqual([]);
    expect(pickableProcesses([null, {}])).toEqual([]);
  });
});

describe('custom programs in prefs', () => {
  const fake = () => ({ prefs: {}, savePrefs() {} });
  it('adds, replaces by executable name, and removes', () => {
    const store = fake();
    expect(addCustomProgram(store, { name: 'Blender', executable: 'blender' })).toBe(true);
    expect(addCustomProgram(store, { name: 'Blender 4', executable: '/opt/blender' })).toBe(true);
    expect(customPrograms(store)).toEqual([{ name: 'Blender 4', executable: '/opt/blender' }]);
    removeCustomProgram(store, '/opt/blender');
    expect(customPrograms(store)).toEqual([]);
  });
  it('refuses an empty name or executable and ignores bad stored data', () => {
    const store = fake();
    expect(addCustomProgram(store, { name: ' ', executable: 'x' })).toBe(false);
    store.prefs.customPrograms = [null, { name: 3 }, { name: 'ok', executable: 'ok' }];
    expect(customPrograms(store)).toEqual([{ name: 'ok', executable: 'ok' }]);
  });
});
