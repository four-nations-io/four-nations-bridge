// content-changed signal unit tests (initiative `synology-photos-reindex`).
//
// Runs against the COMPILED daemon (`npm run build` first), same as
// mirror-path.test.js — exercises what ships in the image, not a re-transpiled copy.
//
//     npm run build && npm test
//
// ⭐ THE PROPERTY THAT MATTERS HERE IS "NEVER THROWS". This signal is called from
// the create-project success path; if it can throw, an unwritable state dir turns
// into a FAILED FOLDER CREATION. The consequence of the signal failing is that the
// operator re-indexes Synology Photos by hand — exactly where they were before it
// existed. The consequence of it throwing is a broken feature. So the no-throw
// contract is tested first and hardest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  signalContentChanged,
  contentChangedFlagPath,
  CONTENT_CHANGED_FLAG,
} = require('../dist/content-changed-signal');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fn-signal-'));
}

test('flag path is composed under the state dir', () => {
  assert.equal(
    contentChangedFlagPath('/data/managed/_state'),
    path.join('/data/managed/_state', CONTENT_CHANGED_FLAG)
  );
});

test('writes the flag into an existing state dir', async () => {
  const dir = tmpdir();
  assert.equal(await signalContentChanged(dir), true);
  assert.ok(fs.existsSync(path.join(dir, CONTENT_CHANGED_FLAG)), 'flag should exist');
});

test('creates the state dir when it does not exist yet', async () => {
  // Real case: a fresh install signalling before pairing has created _state.
  const dir = path.join(tmpdir(), 'not', 'yet', '_state');
  assert.equal(await signalContentChanged(dir), true);
  assert.ok(fs.existsSync(path.join(dir, CONTENT_CHANGED_FLAG)));
});

test('is idempotent — the flag is a request, not a queue', async () => {
  // Ten folders created before the host looks still need exactly one reindex:
  // the reindex takes no path argument and reconciles the whole shared space.
  const dir = tmpdir();
  for (let i = 0; i < 10; i++) {
    assert.equal(await signalContentChanged(dir), true);
  }
  const entries = fs.readdirSync(dir);
  assert.deepEqual(entries, [CONTENT_CHANGED_FLAG], 'should be exactly one flag file');
});

test('returns false instead of throwing when the state dir is unwritable', async () => {
  const parent = tmpdir();
  const dir = path.join(parent, 'locked', '_state');
  fs.mkdirSync(path.join(parent, 'locked'));
  fs.chmodSync(path.join(parent, 'locked'), 0o500); // r-x — mkdir inside must fail
  try {
    // ⛔ The assertion is that this RESOLVES. If it ever rejects, create-project
    // breaks on a read-only managed folder.
    const ok = await signalContentChanged(dir);
    assert.equal(ok, false, 'should report failure, not succeed');
  } finally {
    fs.chmodSync(path.join(parent, 'locked'), 0o700);
  }
});

test('returns false instead of throwing on an empty state dir path', async () => {
  assert.equal(await signalContentChanged(''), false);
});

test('a path that is a FILE, not a directory, is survived', async () => {
  // mkdir -p over an existing file throws EEXIST/ENOTDIR; must be swallowed.
  const parent = tmpdir();
  const asFile = path.join(parent, 'state-is-a-file');
  fs.writeFileSync(asFile, 'not a dir');
  assert.equal(await signalContentChanged(asFile), false);
});
