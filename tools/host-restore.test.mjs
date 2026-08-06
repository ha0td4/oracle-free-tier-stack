import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const hasBash = spawnSync('bash', ['--version']).status === 0;
// The real rsync, resolved before any shim is on PATH; the rsync shim passes through to it
const realRsync = spawnSync('bash', ['-c', 'command -v rsync'], { encoding: 'utf8' }).stdout.trim();
const hasFlock = spawnSync('bash', ['-c', 'command -v flock']).status === 0;
// Past the lock, restore.sh needs flock and rsync (Linux; not in Git Bash)
const NO_LOCKED_RUN = !hasBash || !hasFlock || !realRsync ? 'needs bash, flock and rsync' : false;

// Logs argv to $RESTORE_CALLS, one line per call, tab-separated
const LOG_LINE = (name) => [
  `printf '%s' '${name}' >> "$RESTORE_CALLS"`,
  'for a in "$@"; do printf \'\\t%s\' "$a" >> "$RESTORE_CALLS"; done',
  'echo >> "$RESTORE_CALLS"',
].join('\n');

// A scratch copy of backup/ under <work>/stack: lib.sh sets STACK_DIR from the script's own location, so every
// path the script writes or removes lands in the copy. Shims go first on PATH.
function sandbox() {
  const work = mkdtempSync(join(tmpdir(), 'host-restore-'));
  const stack = join(work, 'stack');
  const bin = join(work, 'bin');
  const snapshot = join(work, 'snapshot'); // what `restic restore` writes into the target
  mkdirSync(stack);
  mkdirSync(bin);
  mkdirSync(snapshot);
  cpSync(new URL('backup/', root), join(stack, 'backup'), { recursive: true });
  const fakeStack = join(work, 'fake-stack.sh');
  writeFileSync(fakeStack, `#!/bin/sh\n${LOG_LINE('stack.sh')}\n`);
  const calls = join(work, 'calls.log');
  writeFileSync(calls, '');
  return { work, stack, bin, snapshot, fakeStack, calls };
}

function writeShim(sb, name, body = '') {
  const p = join(sb.bin, name);
  writeFileSync(p, `#!/bin/sh\n${LOG_LINE(name)}\n${body}\n`);
  chmodSync(p, 0o755);
}

// id -u is the only id call restore.sh makes. uid 0 skips the sudo handover.
function writeId(sb, uid) {
  const p = join(sb.bin, 'id');
  writeFileSync(p, `#!/bin/sh\necho ${uid}\n`);
  chmodSync(p, 0o755);
}

function shims(sb, uid) {
  writeId(sb, uid);
  // sudo exits 7 so a handover shows in the exit status (restore.sh execs sudo, so its status is the result)
  writeShim(sb, 'sudo', 'exit 7');
  writeShim(sb, 'docker');
  writeShim(sb, 'systemctl');
  writeShim(sb, 'rsync', `exec "$REAL_RSYNC" "$@"`);
  // restic restore <id> --target <dir>: copies $FAKE_SNAPSHOT into <dir>/<STAGING_DIR>, or fails if FAKE_RESTIC_FAIL is set
  writeShim(sb, 'restic', [
    'if [ "$1" = restore ]; then',
    '  if [ -n "$FAKE_RESTIC_FAIL" ]; then echo "fake restic: restore failed" >&2; exit 1; fi',
    '  while [ "$#" -gt 0 ]; do if [ "$1" = --target ]; then T="$2"; fi; shift; done',
    '  mkdir -p "$T/staging" && cp -R "$FAKE_SNAPSHOT/." "$T/staging/"',
    'fi',
    'exit 0',
  ].join('\n'));
}


function run(sb, args, extraEnv = {}) {
  return spawnSync('bash', ['backup/restore.sh', ...args], {
    cwd: sb.stack,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${sb.bin}:${process.env.PATH}`,
      RESTORE_CALLS: sb.calls,
      FAKE_SNAPSHOT: sb.snapshot,
      REAL_RSYNC: realRsync,
      LOCK_FILE: join(sb.work, 'restore.lock'),
      ...extraEnv,
    },
  });
}

// Commands the shims saw, one array per call: [name, ...argv]
function calls(sb) {
  return readFileSync(sb.calls, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
}

function installStackSh(sb) {
  cpSync(sb.fakeStack, join(sb.stack, 'stack.sh'));
  chmodSync(join(sb.stack, 'stack.sh'), 0o755);
}

const REPO_ENV = [
  'RESTIC_PASSWORD=test-only',
  'PRIMARY_REPOSITORY=s3:https://example.invalid/bucket/repo',
  'PRIMARY_AWS_ACCESS_KEY_ID=test',
  'PRIMARY_AWS_SECRET_ACCESS_KEY=test',
  'PRIMARY_AWS_DEFAULT_REGION=auto',
  'STAGING_DIR=/staging',
].join('\n') + '\n';

function writeBackupEnv(sb, text) {
  writeFileSync(join(sb.stack, 'backup', 'backup.env'), text);
}

// Every file and directory under dir with its contents, so "changed nothing" is a whole-tree comparison
function tree(dir, rel = '') {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const p = join(rel, e.name);
    return e.isDirectory() ? [`${p}/`, ...tree(dir, p)] : [`${p}=${readFileSync(join(dir, p), 'utf8')}`];
  }).sort();
}


test('an unknown flag exits 2 with usage on stderr and runs no command', { skip: !hasBash }, () => {
  const sb = sandbox();
  try {
    shims(sb, 0);
    const r = run(sb, ['--bogus']);
    assert.equal(r.status, 2);
    assert.notEqual(r.stderr.trim(), '', 'usage should be printed');
    assert.deepEqual(calls(sb), []);
  } finally { rmSync(sb.work, { recursive: true, force: true }); }
});

test('more than two positional arguments exits 2 before the sudo handover', { skip: !hasBash }, () => {
  const sb = sandbox();
  try {
    shims(sb, 1000); // non-root: a handover would show up as a sudo call
    const r = run(sb, ['PRIMARY', 'latest', 'extra']);
    assert.equal(r.status, 2);
    assert.deepEqual(calls(sb), []);
  } finally { rmSync(sb.work, { recursive: true, force: true }); }
});

test('--help prints usage on stdout, exits 0, and runs nothing even as non-root', { skip: !hasBash }, () => {
  const sb = sandbox();
  try {
    shims(sb, 1000);
    const r = run(sb, ['--help']);
    assert.equal(r.status, 0);
    assert.notEqual(r.stdout.trim(), '', 'usage should go to stdout');
    assert.deepEqual(calls(sb), []);
  } finally { rmSync(sb.work, { recursive: true, force: true }); }
});

test('a non-root run hands over to sudo with the same arguments and does nothing else', { skip: !hasBash }, () => {
  const sb = sandbox();
  try {
    shims(sb, 1000);
    const r = run(sb, ['-y', 'PRIMARY', 'abc123']);
    assert.equal(r.status, 7, 'the exit status should be the one sudo returned');
    assert.deepEqual(calls(sb), [['sudo', 'backup/restore.sh', '-y', 'PRIMARY', 'abc123']]);
  } finally { rmSync(sb.work, { recursive: true, force: true }); }
});

test('a missing backup.env exits 1 and changes nothing in the stack dir', { skip: !hasBash }, () => {
  const sb = sandbox();
  try {
    shims(sb, 0);
    writeFileSync(join(sb.stack, 'docker-compose.yml'), 'v1\n');
    mkdirSync(join(sb.stack, 'data'));
    writeFileSync(join(sb.stack, 'data', 'app.txt'), 'keep\n');
    const before = tree(sb.stack);
    const r = run(sb, ['--yes', 'PRIMARY']);
    assert.equal(r.status, 1);
    assert.notEqual(r.stderr.trim(), '', 'the missing file should be reported');
    assert.deepEqual(calls(sb), [], 'no restic, rsync or stack.sh call');
    assert.deepEqual(tree(sb.stack), before);
  } finally { rmSync(sb.work, { recursive: true, force: true }); }
});

test('restore refuses when the repository is not configured and calls no restic', { skip: NO_LOCKED_RUN }, () => {
  const sb = sandbox();
  try {
    shims(sb, 0);
    writeBackupEnv(sb, REPO_ENV.replace(/^PRIMARY_REPOSITORY=.*$/m, 'PRIMARY_REPOSITORY='));
    const r = run(sb, ['--yes', 'PRIMARY']);
    assert.equal(r.status, 1);
    assert.deepEqual(calls(sb), []);
  } finally { rmSync(sb.work, { recursive: true, force: true }); }
});

test('a restic restore failure leaves the stack as it was: no stop, no rsync', { skip: NO_LOCKED_RUN }, () => {
  const sb = sandbox();
  try {
    shims(sb, 0);
    writeBackupEnv(sb, REPO_ENV);
    writeFileSync(join(sb.stack, '.env'), 'STACK_TIER=n8n-only\n');
    installStackSh(sb);
    writeFileSync(join(sb.stack, 'docker-compose.yml'), 'v1\n');
    const before = tree(sb.stack);
    const r = run(sb, ['--yes', 'PRIMARY', 'missing-snapshot'], { FAKE_RESTIC_FAIL: '1' });
    assert.notEqual(r.status, 0);
    assert.ok(!calls(sb).some(([name]) => name === 'rsync' || name === 'stack.sh'));
    assert.deepEqual(tree(sb.stack), before);
  } finally { rmSync(sb.work, { recursive: true, force: true }); }
});

test('a successful restore stops the stack before rsync, and --delete keeps excluded paths', { skip: NO_LOCKED_RUN }, () => {
  const sb = sandbox();
  try {
    shims(sb, 0);
    writeBackupEnv(sb, REPO_ENV);
    writeFileSync(join(sb.stack, '.env'), 'STACK_TIER=n8n-only\n');
    installStackSh(sb);
    writeFileSync(join(sb.stack, 'docker-compose.yml'), 'v1\n');
    writeFileSync(join(sb.stack, 'old-only.txt'), 'not in the snapshot\n');
    mkdirSync(join(sb.stack, '.git'));
    writeFileSync(join(sb.stack, '.git', 'HEAD'), 'ref\n');
    // the snapshot holds the stack as it was backed up: .env, the compose file, stack.sh and backup/
    writeFileSync(join(sb.snapshot, '.env'), 'STACK_TIER=n8n-only\n');
    // a different size: rsync skips a file whose size and mtime match, and both files are written in the same second here
    writeFileSync(join(sb.snapshot, 'docker-compose.yml'), 'version 2\n');
    cpSync(sb.fakeStack, join(sb.snapshot, 'stack.sh'));
    cpSync(new URL('backup/', root), join(sb.snapshot, 'backup'), { recursive: true });
    const r = run(sb, ['--yes', 'PRIMARY']);
    assert.equal(r.status, 0, r.stderr);
    const names = calls(sb).map(([name, ...argv]) => [name, ...argv].join(' '));
    const stopAt = names.findIndex((c) => c.startsWith('stack.sh stop'));
    const rsyncAt = names.findIndex((c) => c.startsWith('rsync'));
    assert.ok(stopAt >= 0 && rsyncAt > stopAt, 'stop must come before rsync');
    assert.equal(readFileSync(join(sb.stack, 'docker-compose.yml'), 'utf8'), 'version 2\n');
    assert.ok(!readdirSync(sb.stack).includes('old-only.txt'), 'a file not in the snapshot is removed');
    assert.equal(readFileSync(join(sb.stack, '.git', 'HEAD'), 'utf8'), 'ref\n', 'excluded paths are kept');
  } finally { rmSync(sb.work, { recursive: true, force: true }); }
});

