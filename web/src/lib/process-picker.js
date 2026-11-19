// Pure helpers behind the "Add a program" picker: turning a running process into a readable name and trimming the list to what a person would plausibly pick.

const SYSTEM_PATH = /^(\/usr\/lib|\/usr\/libexec|\/lib|\/lib64|\/sbin|\/usr\/sbin|\/proc|\/sys|\/usr\/share|[a-z]:\/windows\/|[a-z]:\/program files\/windowsapps)/i;
const OWN = /^(telium|electron)(\.exe)?$/i;

export function executableName(path) {
  return String(path || '').replaceAll('\\', '/').split('/').pop() || '';
}

/// "discovery-d.exe" -> "Discovery D", "my_tool" -> "My Tool": a starting point the user edits.
export function friendlyName(executable) {
  const base = executableName(executable).replace(/\.(exe|appimage|x86_64|bin|sh|py)$/i, '');
  const words = base.split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '';
  return words.map((w) => (w === w.toUpperCase() && w.length > 1 ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
}

/// `rows` are `{ executable, path, count }`. Hides system plumbing and what is already added; sorts by name; matches the query against the name and path.
export function pickableProcesses(rows, { query = '', listed = [] } = {}) {
  const have = new Set(listed.map((p) => executableName(p.executable).toLowerCase()));
  const q = String(query || '').trim().toLowerCase();
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.executable && !OWN.test(row.executable))
    .filter((row) => !have.has(row.executable.toLowerCase()))
    .filter((row) => !SYSTEM_PATH.test(String(row.path || '').replaceAll('\\', '/')))
    .filter((row) => !q || row.executable.toLowerCase().includes(q) || String(row.path || '').toLowerCase().includes(q))
    .sort((a, b) => a.executable.localeCompare(b.executable, undefined, { sensitivity: 'base' }));
}
