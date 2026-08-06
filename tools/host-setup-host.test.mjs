import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// host/setup-host.sh hardcodes /etc/* and /swapfile, so it is only run up to the points where it stops
// before writing anything (root check, page size, unknown OS, first package-manager call). The package-manager
// shims fail on the first call the test cares about, which stops the run there. Not covered: swap, Docker config,
// Tailscale, CrowdSec, the tailnet-guard call (all after writes to real /etc paths) and the ID_LIKE/PRETTY_NAME edge cases.

const hostDir = fileURLToPath(new URL('../host/', import.meta.url));
const hasBash = spawnSync('bash', ['--version']).status === 0;

// Read-only platform probes; every other shim stands for a change to the machine.
const PROBES = new Set(['id', 'getconf', 'uname']);
const CHANGERS = ['apt-get', 'dnf', 'systemctl', 'timedatectl', 'swapon', 'swapoff', 'fallocate', 'dd', 'mkswap', 'chcon',
  'curl', 'tailscale', 'cscli', 'sysctl', 'usermod', 'firewall-cmd', 'docker', 'rpm', 'dpkg'];

const forward = (p) => p.replace(/\\/g, '/');

function runSetup({ uid = 0, pagesize = 4096, osRelease = 'ID=ubuntu\nPRETTY_NAME="Ubuntu 24.04 LTS"\n', failOn = {}, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'setup-host-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const callsFile = join(dir, 'calls.log');
    writeFileSync(callsFile, '');

    const shim = (name, body = '') => {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$SETUP_HOST_CALLS"\n${body}exit 0\n`);
      chmodSync(join(bin, name), 0o755);
    };
    for (const name of CHANGERS) {
      const word = failOn[name];
      shim(name, word ? `case " $* " in *" ${word} "*) exit 1 ;; esac\n` : '');
    }
    shim('id', `if [ "$1" = -u ]; then echo ${uid}; fi\n`);
    shim('getconf', `if [ "$1" = PAGESIZE ]; then echo ${pagesize}; fi\n`);
    shim('uname', 'case "$1" in -m) echo x86_64 ;; -r) echo 6.8.0 ;; *) echo Linux ;; esac\n');

    // BASH_ENV is read by the non-interactive bash that runs the script. It only redirects the one read of
    // /etc/os-release to a fixture; every other `.` is the builtin.
    const osFile = join(dir, 'os-release');
    writeFileSync(osFile, osRelease);
    const seam = join(dir, 'seam.sh');
    writeFileSync(seam, '.() { if [ "$1" = /etc/os-release ]; then builtin . "$SETUP_HOST_OS_RELEASE"; else builtin . "$@"; fi; }\n');

    const base = { ...process.env };
    for (const k of ['ALLOW_64K', 'SKIP_CROWDSEC', 'SWAP_SIZE_MB', 'TZ_NAME', 'SUDO_USER']) delete base[k];
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
    base[pathKey] = `${bin}:${process.env[pathKey]}`;

    const r = spawnSync('bash', ['setup-host.sh'], {
      cwd: hostDir,
      encoding: 'utf8',
      env: { ...base, ...env, BASH_ENV: forward(seam), SETUP_HOST_CALLS: forward(callsFile), SETUP_HOST_OS_RELEASE: forward(osFile) },
    });
    const calls = readFileSync(callsFile, 'utf8').split('\n').filter(Boolean);
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      calls,
      changes: calls.filter((c) => !PROBES.has(c.split(' ')[0])),
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('without root the script stops at once and runs no commands', { skip: !hasBash }, () => {
  const r = runSetup({ uid: 1000 });
  assert.equal(r.status, 1);
  assert.notEqual(r.stderr, '', 'the refusal is reported on stderr');
  assert.deepEqual(r.calls, ['id -u']);
});

test('a 64K kernel page size stops the run and nothing is changed', { skip: !hasBash }, () => {
  const r = runSetup({ pagesize: 65536 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /65536/, 'the refusal names the page size it found');
  assert.deepEqual(r.changes, []);
});

test('a 4K kernel passes the page-size check and reaches the package step', { skip: !hasBash }, () => {
  const r = runSetup({ pagesize: 4096, failOn: { 'apt-get': 'update' } });
  assert.equal(r.status, 1, 'the apt-get shim stops the run at its first call');
  assert.deepEqual(r.changes, ['apt-get update']);
});

test('ALLOW_64K=1 lets a 64K kernel past the page-size check', { skip: !hasBash }, () => {
  const r = runSetup({ pagesize: 65536, env: { ALLOW_64K: '1' }, failOn: { 'apt-get': 'update' } });
  assert.equal(r.status, 1, 'the apt-get shim stops the run at its first call');
  assert.deepEqual(r.changes, ['apt-get update']);
});

test('an unsupported OS is refused before the page-size check or any package manager', { skip: !hasBash }, () => {
  const r = runSetup({ osRelease: 'ID=plan9\nPRETTY_NAME="Plan 9"\n' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Plan 9/, 'the refusal names the OS it found');
  assert.deepEqual(r.changes, []);
  assert.ok(!r.calls.some((c) => c.startsWith('getconf')), 'the page size is not read for an unsupported OS');
});

test('Debian-family hosts (by ID or ID_LIKE) use apt-get, not dnf', { skip: !hasBash }, () => {
  for (const osRelease of ['ID=debian\nPRETTY_NAME="Debian"\n', 'ID=pop\nID_LIKE="ubuntu debian"\nPRETTY_NAME="Pop"\n']) {
    const r = runSetup({ osRelease, failOn: { 'apt-get': 'update', dnf: 'upgrade' } });
    assert.equal(r.status, 1, osRelease);
    assert.deepEqual(r.changes, ['apt-get update'], osRelease);
  }
});

test('RHEL-family hosts (by ID or ID_LIKE) use dnf, not apt-get', { skip: !hasBash }, () => {
  for (const osRelease of ['ID=ol\nPRETTY_NAME="Oracle Linux Server 9.4"\n', 'ID=foo\nID_LIKE="rhel fedora"\nPRETTY_NAME="Foo"\n']) {
    const r = runSetup({ osRelease, failOn: { 'apt-get': 'update', dnf: 'upgrade' } });
    assert.equal(r.status, 1, osRelease);
    assert.deepEqual(r.changes, ['dnf -y upgrade --refresh'], osRelease);
  }
});
