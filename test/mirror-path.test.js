// Host-path → container-mirror unit tests (planning doc 119).
//
// Runs against the COMPILED daemon (`npm run build` first) so it exercises exactly
// what ships in the image, not a re-transpiled copy. Node's built-in test runner —
// no new dependency in a container image creators pull.
//
//     npm run build && npm test
//
// The vectors live in src/source-roots/mirror-path-vectors.json and are shared with
// the web wizard's parity test; see that file's header for why.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeHostPath, hostPathToContainerPath, SOURCE_HOST_PREFIX } = require(
  '../dist/source-roots/resolve'
);

const VECTORS = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'src', 'source-roots', 'mirror-path-vectors.json'),
    'utf8'
  )
);

test('POSIX host paths map byte-identically (installed-base regression fence)', () => {
  for (const v of VECTORS.posix) {
    assert.equal(normalizeHostPath(v.input), v.canonical, `canonical: ${v.why}`);
    assert.equal(hostPathToContainerPath(v.canonical), v.mirror, `mirror: ${v.why}`);
  }
});

test('Windows host paths map to their POSIX mirror', () => {
  for (const v of VECTORS.windows) {
    assert.equal(normalizeHostPath(v.input), v.canonical, `canonical: ${v.why}`);
    assert.equal(hostPathToContainerPath(v.canonical), v.mirror, `mirror: ${v.why}`);
  }
});

test('canonicalizing is idempotent (a re-paste can never produce a second spelling)', () => {
  for (const v of [...VECTORS.posix, ...VECTORS.windows]) {
    assert.equal(normalizeHostPath(v.canonical), v.canonical, v.why);
  }
});

test('the raw pasted form maps to the same mirror as its canonical form', () => {
  // The daemon reads CONTENT_BRIDGE_HOST_CONTENT_PATH straight from bridge.env, and a
  // creator may hand-edit it. Backslashes / quotes / a trailing slash must still land
  // on the mount compose created.
  for (const v of VECTORS.windows) {
    const canonical = normalizeHostPath(v.input);
    assert.equal(hostPathToContainerPath(canonical), v.mirror, v.why);
  }
});

test('unsafe and unsupported paths are rejected', () => {
  for (const v of VECTORS.rejected) {
    assert.equal(normalizeHostPath(v.input), null, `normalize: ${v.why}`);
  }
});

test('every mirror stays under the bind prefix, and no traversal survives', () => {
  const escapes = [
    'C:\\Users\\..\\..\\Windows\\System32',
    'C:/../../../etc/passwd',
    '/volume1/../../etc/passwd',
    '/../../etc/passwd',
    'C:\\..',
    '..',
    '../etc',
    './relative',
  ];
  for (const raw of escapes) {
    const mirror = hostPathToContainerPath(raw);
    if (mirror === null) continue; // rejected outright is fine
    assert.ok(
      mirror === SOURCE_HOST_PREFIX || mirror.startsWith(`${SOURCE_HOST_PREFIX}/`),
      `escaped the bind prefix: ${raw} -> ${mirror}`
    );
    assert.ok(!mirror.split('/').includes('..'), `".." survived: ${raw} -> ${mirror}`);
  }
});

test('drive-letter case cannot split the mount from the index', () => {
  // The failure this guards: compose binds what the creator typed, the daemon
  // computes the mirror. If `C:` and `c:` produced different mirrors, the daemon
  // would report needs_mount with everything apparently configured correctly.
  assert.equal(
    hostPathToContainerPath('C:/Users/Home/Vids'),
    hostPathToContainerPath('c:/Users/Home/Vids')
  );
  assert.equal(
    hostPathToContainerPath('C:\\Users\\Home\\Vids'),
    hostPathToContainerPath('C:/Users/Home/Vids')
  );
});

test('a bare drive and a UNC share never reach the mirror', () => {
  assert.equal(hostPathToContainerPath('C:'), null);
  assert.equal(normalizeHostPath('\\\\server\\share'), null);
});
