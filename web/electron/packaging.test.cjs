'use strict';

// A packaged script requiring anything not in package.json `files` kills the main process (as `page-zoom.cjs` did).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ELECTRON_DIR = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8'));
const patterns = pkg.build.files || [];

function patternToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if ('\\^$+?.()|{}[]'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`${out}$`);
}

const matchers = patterns.map(patternToRegExp);

function isPackaged(relativePosix) {
  return matchers.some((match) => match.test(relativePosix));
}

// Comments are stripped first: a `require` inside one names nothing.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\n]|["'`);,{}])\/\/[^\n]*/g, '$1');
}

const SPECIFIER = /(?:require\(\s*|(?:import|export)[^'"]*?from\s+|import\(\s*)['"](\.[^'"]+)['"]/g;

function relativeRequires(sourcePath) {
  const source = stripComments(fs.readFileSync(sourcePath, 'utf8'));
  const found = [];
  let match;
  while ((match = SPECIFIER.exec(source)) !== null) {
    found.push(match[1]);
  }
  return found;
}

test('every relative require in a packaged script is packaged too', () => {
  const missing = [];
  for (const pattern of patterns) {
    // Only concrete root scripts; globs name asset trees and helpers are reached via root files.
    if (pattern.includes('*') || !/\.(cjs|mjs)$/.test(pattern)) continue;
    const sourcePath = path.join(ELECTRON_DIR, pattern);
    if (!fs.existsSync(sourcePath)) {
      missing.push(`${pattern} is listed in build.files but is not on disk`);
      continue;
    }
    for (const specifier of relativeRequires(sourcePath)) {
      const resolved = path.normalize(path.join(path.dirname(sourcePath), specifier));
      const relativePosix = path.relative(ELECTRON_DIR, resolved).split(path.sep).join('/');
      if (!isPackaged(relativePosix)) {
        missing.push(`${pattern} requires ${specifier} (${relativePosix}), which build.files does not cover`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

// Asset names must be stable across versions and slash-free; the URL uses `desktop-latest`, since `releases/latest` is shared by every train.
test('the artifact names the site links to are the names electron-builder writes', () => {
  const config = fs.readFileSync(
    path.resolve(ELECTRON_DIR, '../../site/src/config.ts'),
    'utf8',
  );

  const expand = (template, arch, ext) => template
    .replace(/\$\{version\}/g, '0.0.0')
    .replace(/\$\{arch\}/g, arch)
    .replace(/\$\{ext\}/g, ext);

  const names = {
    linux: expand(pkg.build.artifactName, 'x86_64', 'AppImage'),
    windows: expand(pkg.build.win.artifactName, 'x64', 'exe'),
  };

  for (const [platform, name] of Object.entries(names)) {
    assert.ok(
      !pkg.build.artifactName.includes('${version}')
        && !(platform === 'windows' && pkg.build.win.artifactName.includes('${version}')),
      `${platform} artifact name contains \${version}, so the site cannot link to it by a fixed name`,
    );
    assert.ok(
      config.includes(`releases/download/desktop-latest/${name}`),
      `site/src/config.ts does not link to ${name} on desktop-latest; the ${platform} download button will 404`,
    );
    assert.ok(
      !config.includes(`releases/latest/download/${name}`),
      `site/src/config.ts still resolves the ${platform} button through releases/latest, which any non-prerelease release from another train can take over`,
    );
  }
});

test('both desktop release jobs mirror their files onto desktop-latest', () => {
  for (const workflow of ['build-appimage.yml', 'build-windows.yml']) {
    const source = fs.readFileSync(
      path.resolve(ELECTRON_DIR, '../../.github/workflows', workflow),
      'utf8',
    );
    assert.ok(
      source.includes('scripts/publish-desktop-latest.sh'),
      `${workflow} does not run scripts/publish-desktop-latest.sh, so desktop-latest goes stale`,
    );
  }
});

// `--latest=false` keeps a train out of the shared Latest slot.
test('no release workflow marks its release prerelease', () => {
  const files = [
    '.github/workflows/build-appimage.yml',
    '.github/workflows/build-windows.yml',
    '.github/workflows/build-android-arm64.yml',
    '.github/workflows/release-server.yml',
    'scripts/publish-desktop-latest.sh',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.resolve(ELECTRON_DIR, '../..', file), 'utf8');
    const usesFlag = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .some((line) => /(^|\s)--prerelease(\s|$)/.test(line));
    assert.ok(!usesFlag, `${file} passes --prerelease; use --latest=false to keep a release out of the Latest slot`);
  }
});

// Clients built before `desktop-latest` read `releases/latest/download/client-releases.json`, so desktop owns Latest.
test('desktop releases claim the Latest slot explicitly', () => {
  for (const workflow of ['build-appimage.yml', 'build-windows.yml']) {
    const source = fs.readFileSync(
      path.resolve(ELECTRON_DIR, '../../.github/workflows', workflow),
      'utf8',
    );
    assert.ok(
      /gh release (create|edit)[\s\S]{0,400}--latest(\s|$)/.test(source),
      `${workflow} never passes --latest, so an older client's update URL depends on GitHub's guess`,
    );
  }
});

// The server train's releases must stay out of the Latest slot or both desktop buttons 404.
test('server releases stay out of the Latest slot', () => {
  const source = fs.readFileSync(
    path.resolve(ELECTRON_DIR, '../../.github/workflows/release-server.yml'),
    'utf8',
  );
  // Comments stripped first so prose mentioning `--latest=false` does not count.
  const code = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const commands = [...code.matchAll(/gh release (?:create|edit)[\s\S]*?(?=\n\s*(?:gh |if |else|fi|echo |\{|\}|$))/g)]
    .map((m) => m[0]);
  assert.ok(commands.length > 0, 'release-server.yml never cuts a release');
  for (const command of commands) {
    assert.ok(
      /--latest=false/.test(command),
      `release-server.yml runs a release command without --latest=false:\n${command.trim()}`,
    );
  }
  // Nothing builds from a branch push: that would publish unreleased commits.
  assert.ok(
    !/^\s{4}branches:/m.test(source),
    'release-server.yml still triggers on a branch push; a server release is a tag',
  );
  assert.ok(
    /tags:\s*\n\s*- 'server-v\*'/.test(source),
    'release-server.yml does not trigger on server-v* tags',
  );
});
