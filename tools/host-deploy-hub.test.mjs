import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// host/hub/deploy-hub.sh runs in place. Only what runs without root and without the machine-changing branches is exercised:
// dry runs, status, restore's checks, and refusals before any change. Each run starts in a scratch directory and uses relative
// paths, so no tar argument carries a drive letter (GNU tar reads "C:" as a remote host).
const posix = (p) => p.replaceAll('\\', '/');
const scriptPath = posix(fileURLToPath(new URL('../host/hub/deploy-hub.sh', import.meta.url)));
const hasBash = spawnSync('bash', ['--version']).status === 0;

// Commands that change the machine. A dry run prints these instead of running them, so none may appear in the shim log.
const MUTATING = /^(apt-get (install|update|purge)|apt-mark (hold|unhold)|useradd|userdel|groupdel|curl|gpg|mkswap|swapon|swapoff|sysctl|modprobe|update-grub|grubby|firewall-cmd|iptables|ip6tables|systemctl (start|stop|restart|enable|disable|daemon-reload|reload))\b/;

// Shims: each external command appends its argv to $SHIM_LOG. `id` is silent because the script asks for it everywhere; it
// reports uid FAKE_UID (1000 unless a test says otherwise), so every run is non-root.
const LOG = 'echo "$(basename "$0") $*" >> "$SHIM_LOG"';
const SHIMS = {
  id: 'if [ "$1" = -u ]; then echo "${FAKE_UID:-1000}"; exit 0; fi\nexit 1',
  free: `${LOG}\ncat <<'TABLE'\n              total        used        free      shared  buff/cache   available\nMem:           1024         300         500           1         200         600\nSwap:          4096           0        4096\nTABLE`,
  systemctl: `${LOG}\ncase "$1" in is-active|is-enabled) exit 1 ;; esac\nexit 0`,
  promtool: `${LOG}\nexit 0`,
  loki: `${LOG}\nexit 0`,
  tempo: `${LOG}\nexit 0`,
  cloudflared: `${LOG}\nexit 0`,
};
for (const c of ['apt-get', 'apt-mark', 'iptables', 'ip6tables', 'firewall-cmd', 'sysctl', 'swapon', 'swapoff', 'mkswap', 'modprobe',
  'update-grub', 'grubby', 'useradd', 'userdel', 'groupdel', 'gpg', 'flock', 'ss', 'chcon']) SHIMS[c] = `${LOG}\nexit 0`;
// These fail loudly if a dry run ever reaches them: the run then stops with a non-zero status.
for (const c of ['curl', 'dpkg-query', 'rpm', 'dnf', 'selinuxenabled']) SHIMS[c] = `${LOG}\nexit 1`;

// The script sources /etc/os-release, which a Windows host lacks, and hard-codes /etc, /var and /run. BASH_ENV wraps the `.`
// builtin so that reading /etc/os-release reads a fixture instead; every other file is sourced as usual.
const OS_RELEASE_SEAM = '.() { if [ "$1" = /etc/os-release ]; then builtin . "$FAKE_OS_RELEASE"; else builtin . "$@"; fi; }\n';

const PASS_THROUGH = ['SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'COMSPEC', 'PATHEXT', 'WINDIR'];

function setShim(fx, name, body) {
  const file = join(fx.shims, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

// A scratch area. The script's settings, backups and log go under root/ (SETTINGS_FILE, BACKUP_DIR, LOG_FILE); its /etc, /var
// and /run paths cannot be moved, which is why the tests stay with what runs without them.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-hub-test-'));
  const fx = { dir, shims: join(dir, 'shims'), root: join(dir, 'root'), settings: join(dir, 'root', 'settings.env'), backups: join(dir, 'root', 'backups') };
  mkdirSync(fx.shims);
  mkdirSync(fx.root);
  mkdirSync(join(dir, 'dashboards'));
  writeFileSync(join(dir, 'dashboards', 'hosts.json'), '{}\n');
  writeFileSync(join(dir, 'grafana-admin.txt'), 'GrafanaAdmin-Secret-4471\n');
  writeFileSync(join(dir, 'os-release'), 'PRETTY_NAME="Ubuntu 24.04 LTS"\nVERSION_CODENAME=noble\n');
  writeFileSync(join(dir, 'os-release.sh'), OS_RELEASE_SEAM);
  for (const [name, body] of Object.entries(SHIMS)) setShim(fx, name, body);
  const env = {};
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  fx.env = {
    ...env,
    PATH: [fx.shims, process.env.PATH].join(delimiter),
    LC_ALL: 'C',
    FAKE_UID: '1000',
    BASH_ENV: posix(join(dir, 'os-release.sh')),
    FAKE_OS_RELEASE: posix(join(dir, 'os-release')),
    SHIM_LOG: 'calls.log',
    SETTINGS_FILE: 'root/settings.env',
    BACKUP_DIR: 'root/backups',
    LOG_FILE: 'root/deploy-hub.log',
  };
  return fx;
}

function runHub(fx, args, env = {}) {
  return spawnSync('bash', [scriptPath, ...args], { cwd: fx.dir, env: { ...fx.env, ...env }, encoding: 'utf8', timeout: 60000 });
}

const calls = (fx) => (existsSync(join(fx.dir, 'calls.log')) ? readFileSync(join(fx.dir, 'calls.log'), 'utf8') : '').split('\n').filter(Boolean);
const tree = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }) : []);
const mutating = (fx) => calls(fx).filter((c) => MUTATING.test(c));
const cleanup = (fx) => rmSync(fx.dir, { recursive: true, force: true });

// The status table: "    KEY value origin" rows.
function settingsRows(out) {
  const rows = {};
  for (const line of out.split('\n')) {
    const m = /^ {4}([A-Z_]+)\s+(\S+)\s+(\S+)$/.exec(line);
    if (m) rows[m[1]] = `${m[2]} ${m[3]}`;
  }
  return rows;
}

// A dry-run install with the fixture dashboards and Grafana password file; the firewall is off because it reads the host's routes.
const dryInstall = (extra = []) => ['dry-run', '--no-firewall', '--domain', 'example.com', '--dashboards', 'dashboards',
  '--grafana-password-file', 'grafana-admin.txt', ...extra];

// A backup archive as backup_make writes it: the backup-meta member at the path restore reads.
function makeArchive(fx, name, meta) {
  mkdirSync(join(fx.dir, 'archive-src', 'var', 'lib', 'deploy-hub'), { recursive: true });
  writeFileSync(join(fx.dir, 'archive-src', 'var', 'lib', 'deploy-hub', 'backup-meta'), meta);
  mkdirSync(fx.backups, { recursive: true });
  const r = spawnSync('bash', ['-c', 'cd archive-src && tar -czf "$1" var', 'sh', `../root/backups/${name}`], { cwd: fx.dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('bad arguments exit 2 and --help exits 0, with no command run', { skip: !hasBash }, () => {
  const fx = fixture();
  try {
    for (const args of [['bogus'], [], ['dry-run', '--domain'], ['dry-run', '--domain', '--hub-name', 'x']]) {
      const r = runHub(fx, args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    }
    assert.equal(runHub(fx, ['--help']).status, 0);
    assert.deepEqual(calls(fx), []);
    assert.deepEqual(tree(fx.root), []);
  } finally { cleanup(fx); }
});

test('install without root refuses before it changes anything', { skip: !hasBash }, () => {
  const fx = fixture();
  try {
    const r = runHub(fx, ['install', '--no-firewall', '--domain', 'example.com', '--dashboards', 'dashboards',
      '--grafana-password-file', 'grafana-admin.txt']);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(calls(fx), []);
    assert.deepEqual(tree(fx.root), []);
  } finally { cleanup(fx); }
});

test('settings: a flag beats the environment, the environment beats the saved file, the saved file beats the default', { skip: !hasBash }, () => {
  const fx = fixture();
  try {
    writeFileSync(fx.settings, 'LOGS_RETENTION_DAYS=30\nHUB_NAME=saved-hub\nMETRICS_RETENTION_DAYS=60\n');
    const show = (args, env) => {
      const r = runHub(fx, ['status', ...args], env);
      assert.equal(r.status, 0, r.stderr);
      return settingsRows(r.stdout);
    };
    const pick = (rows) => [rows.LOGS_RETENTION_DAYS, rows.HUB_NAME, rows.METRICS_RETENTION_DAYS];

    assert.deepEqual(pick(show([])), ['30 saved', 'saved-hub saved', '60 saved']);
    assert.deepEqual(pick(show([], { LOGS_RETENTION_DAYS: '40', HUB_NAME: 'env-hub' })),
      ['40 environment', 'env-hub environment', '60 saved']);
    assert.deepEqual(pick(show(['--logs-retention-days', '50', '--hub-name', 'flag-hub'], { LOGS_RETENTION_DAYS: '40', HUB_NAME: 'env-hub' })),
      ['50 flag', 'flag-hub flag', '60 saved']);

    rmSync(fx.settings);
    assert.deepEqual(pick(show([])), ['90 default', 'observe-hub default', '90 default']);
  } finally { cleanup(fx); }
});

test('a saved file with an unknown key loads the known settings and ignores the unknown one', { skip: !hasBash }, () => {
  const fx = fixture();
  try {
    writeFileSync(fx.settings, 'NOT_A_SETTING=1\nLOGS_RETENTION_DAYS=30\n');
    const r = runHub(fx, ['status']);
    assert.equal(r.status, 0, r.stderr);
    const rows = settingsRows(r.stdout);
    assert.equal(rows.NOT_A_SETTING, undefined);
    assert.equal(rows.LOGS_RETENTION_DAYS, '30 saved');
  } finally { cleanup(fx); }
});

// One full dry run, since each process costs ~75 ms on a Windows host and a full install forks about 150 of them.
test('dry-run changes nothing, runs the config checks, and never prints a secret', { skip: !hasBash }, () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.dir, 'oidc.txt'), 'OidcClient-Secret-9182\n');
    writeFileSync(join(fx.dir, 'tunnel.txt'), 'TunnelToken_abcdefghijklmnopqrstuvwxyz0123\n');
    const r = runHub(fx, dryInstall(['--grafana-oidc-secret-file', 'oidc.txt', '--tunnel-token-file', 'tunnel.txt']));
    assert.equal(r.status, 0, r.stderr);

    assert.deepEqual(tree(fx.root), [], 'no settings, backup or log file written');
    assert.deepEqual(mutating(fx), [], 'no machine-changing command ran');
    assert.ok(calls(fx).some((c) => c.startsWith('promtool check config ')), 'the new Prometheus config is checked');
    assert.ok(calls(fx).some((c) => c.startsWith('loki ')), 'a passing run reaches the Loki config check');

    const out = r.stdout + r.stderr;
    for (const secret of ['GrafanaAdmin-Secret-4471', 'OidcClient-Secret-9182', 'TunnelToken_abcdefghijklmnopqrstuvwxyz0123']) {
      assert.ok(!out.includes(secret), `dry-run output shows ${secret.slice(0, 6)}...`);
    }
    assert.ok(out.includes('***'), 'the secret lines are shown masked');
  } finally { cleanup(fx); }
});

test('a config that fails its check stops the install before the later configs are checked', { skip: !hasBash }, () => {
  const fx = fixture();
  try {
    setShim(fx, 'promtool', `${LOG}\necho 'bad config' >&2\nexit 1`);
    const r = runHub(fx, dryInstall());
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /bad config/, 'the checker output is shown');
    assert.ok(calls(fx).some((c) => c.startsWith('promtool check config ')));
    assert.ok(!calls(fx).some((c) => c.startsWith('loki ')), 'Loki was not checked after the failure');
    assert.deepEqual(tree(fx.root), []);
  } finally { cleanup(fx); }
});

test('restore dry run finds an archive by name in BACKUP_DIR, shows its meta, and stops no service', { skip: !hasBash }, () => {
  const fx = fixture();
  const name = 'hub-manual-full-20260801-101010.tar.gz';
  try {
    makeArchive(fx, name, 'created=2026-08-01T10:10:10+00:00\nkind=manual\nwhat=full\n');
    const r = runHub(fx, ['restore', name, '--yes', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /what=full/, 'the archive meta was read');
    assert.deepEqual(mutating(fx), []);
    assert.deepEqual(calls(fx).filter((c) => c.startsWith('systemctl ')), [], 'no service was stopped or started');
    assert.deepEqual(tree(fx.backups), [name], 'no pre-restore archive was made');
    assert.equal(existsSync(fx.settings), false);
  } finally { cleanup(fx); }
});

test('restore refuses without --yes, a missing file, and a file that is not an archive', { skip: !hasBash }, () => {
  const fx = fixture();
  try {
    makeArchive(fx, 'hub-ok.tar.gz', 'what=full\n');
    writeFileSync(join(fx.backups, 'junk.tar.gz'), 'not an archive\n');
    for (const args of [['restore', 'hub-ok.tar.gz', '--dry-run'], ['restore', 'missing.tar.gz', '--yes', '--dry-run'],
      ['restore', 'junk.tar.gz', '--yes', '--dry-run']]) {
      assert.equal(runHub(fx, args).status, 1, args.join(' '));
    }
    assert.equal(runHub(fx, ['restore', 'hub-ok.tar.gz', '--yes', '--dry-run']).status, 0, 'control: the same archive with --yes passes');
    assert.deepEqual(mutating(fx), []);
  } finally { cleanup(fx); }
});
