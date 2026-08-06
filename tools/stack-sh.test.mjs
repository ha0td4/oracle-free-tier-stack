import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, chmodSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const hasBash = spawnSync('bash', ['--version']).status === 0;

// Run `stack.sh init` in a scratch copy with harmless sudo/chown shims.
function initIn(dir) {
  mkdirSync(join(dir, 'bin'));
  for (const cmd of ['sudo', 'chown']) {
    writeFileSync(join(dir, 'bin', cmd), cmd === 'sudo' ? '#!/bin/sh\nexec "$@"\n' : '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'bin', cmd), 0o755);
  }
  return spawnSync('bash', ['stack.sh', 'init'], { cwd: dir, env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` }, encoding: 'utf8' });
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'stack-'));
  for (const f of ['stack.sh', 'docker-compose.yml', 'docker-compose.observe.yml', 'docker-compose.observe.attach.yml', '.env.example', 'versions.env']) cpSync(new URL(f, root), join(dir, f));
  for (const d of ['backup', 'host', 'tiers']) cpSync(new URL(d, root), join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'tiers', 'n8n-only.env'), 'COMPOSE_PROFILES=n8n\n'); // a small custom tier, as the Plan page writes one
  return dir;
}

test('init creates a data dir for every ./data bind mount in the compose files', { skip: !hasBash }, () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'docker-compose.override.yml'), 'services:\n  demo:\n    image: busybox\n    volumes:\n      - ./data/demo-app:/data\n');
    const r = initIn(dir);
    assert.equal(r.status, 0, r.stderr);
    const dirs = readdirSync(join(dir, 'data'));
    for (const d of ['n8n', 'hermes', 'alloy', 'pocket-id', 'demo-app']) assert.ok(dirs.includes(d), `missing data/${d}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('init does not need a hard-coded directory list', { skip: !hasBash }, () => {
  const dir = scratch();
  try {
    const r = initIn(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, '.env')));
    assert.ok(!readdirSync(join(dir, 'data')).includes('demo-app'));
    // Windows has no Unix modes to check
    if (process.platform !== 'win32') for (const f of ['.env', 'backup/backup.env']) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const hasDocker = spawnSync('docker', ['compose', 'version']).status === 0;

test('the override example adds a service that a custom tier can switch on', { skip: !(hasBash && hasDocker) }, () => {
  const dir = scratch();
  try {
    cpSync(new URL('docker-compose.override.example.yml', root), join(dir, 'docker-compose.override.yml'));
    writeFileSync(join(dir, 'tiers/custom.env'), 'COMPOSE_PROFILES=omniroute,whoami\n');
    const run = (profiles) => spawnSync('docker', ['compose', 'config', '--services'], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, COMPOSE_PROFILES: profiles, CF_TUNNEL_TOKEN: 'x', N8N_ENCRYPTION_KEY: 'x', OMNIROUTE_PASSWORD: 'x', OMNIROUTE_JWT_SECRET: 'x',
        OMNIROUTE_API_KEY_SECRET: 'x', HERMES_DASHBOARD_SECRET: 'x', POCKETID_ENCRYPTION_KEY: 'x', SEARXNG_SECRET: 'x', CRAWL4AI_API_TOKEN: 'x',
        POSTGRES_PASSWORD: 'x', VALKEY_PASSWORD: 'x', OPENWEBUI_SECRET_KEY: 'x', HERMES_DASHBOARD_PASSWORD: 'x', TZ: 'UTC', DOMAIN: 'example.com',
        ...Object.fromEntries(readFileSync(join(dir, 'versions.env'), 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => l.replace(/\s+#.*$/, '').split('='))) },
    }).stdout.split('\n').filter(Boolean);
    assert.ok(run('omniroute,whoami').includes('whoami'), 'whoami should run with its profile');
    assert.ok(!run('omniroute').includes('whoami'), 'whoami should stay off without its profile');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// stack.sh renders the Homer launcher: {{DOMAIN}} is filled in and links of components the tier does not run are dropped.
function renderDash(tierName, domain = 'example.com') {
  const dir = scratch();
  try {
    cpSync(new URL('config', root), join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, '.env'), `DOMAIN=${domain}\nSTACK_TIER=${tierName}\n`);
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'docker'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'bin', 'docker'), 0o755);
    const r = spawnSync('bash', ['stack.sh', 'ps'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(join(dir, 'data', 'dash', 'config.yml'), 'utf8');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// `stack.sh up` with a docker shim: `docker run` (the n8n image hashing the owner password) prints a fixed bcrypt-shaped hash.
const FAKE_HASH = '$2a$10$fakefakefakefakefakefuFAKEfakefakefakefakefakefakefak';
function upWithEnv(env) {
  const dir = scratch();
  try {
    cpSync(new URL('config', root), join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, '.env'), env);
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'docker'), `#!/bin/sh\nif [ "$1" = run ]; then echo run >> "$PWD/docker-runs"; printf '%s' '${FAKE_HASH}'; fi\nexit 0\n`);
    chmodSync(join(dir, 'bin', 'docker'), 0o755);
    const up = () => spawnSync('bash', ['stack.sh', 'up'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } });
    const runs = [up(), up()];
    for (const r of runs) assert.equal(r.status, 0, r.stderr);
    const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
    return { env: read('.env'), dockerRuns: read('docker-runs').split('\n').filter(Boolean).length };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('up stores the n8n owner password hash once, single-quoted, when ADMIN_EMAIL is set', { skip: !hasBash }, () => {
  const { env, dockerRuns } = upWithEnv('DOMAIN=example.com\nSTACK_TIER=n8n-only\nADMIN_EMAIL=me@example.com\nN8N_OWNER_PASSWORD=pw\n');
  const lines = env.split('\n').filter((l) => l.startsWith('N8N_OWNER_PASSWORD_HASH='));
  assert.deepEqual(lines, [`N8N_OWNER_PASSWORD_HASH='${FAKE_HASH}'`]);
  assert.equal(dockerRuns, 2, 'each up checks the stored hash against the password');
});

test('up leaves the n8n owner alone while ADMIN_EMAIL is empty (an owner made by hand)', { skip: !hasBash }, () => {
  const { env, dockerRuns } = upWithEnv('DOMAIN=example.com\nSTACK_TIER=n8n-only\nN8N_OWNER_PASSWORD=pw\n');
  assert.ok(!env.includes('N8N_OWNER_PASSWORD_HASH='));
  assert.equal(dockerRuns, 0);
});

// Pocket ID's API as stack.sh reaches it: host curl at the container's address, the session header and the body in a curl config on
// stdin. Each request is logged to pid-requests as "METHOD PATH", the header line, a blank line, the body. The setup call returns a
// session cookie; secret-<client> is each client's secret.
const PID_API_SHIM = String.raw`pid_api() {
  m=""; url=""; prev=""
  for a in "$@"; do [ "$prev" = -X ] && m="$a"; case "$a" in http://*) url="$a" ;; esac; prev="$a"; done
  path="/$(printf '%s' "$url" | cut -d/ -f4-)"
  cfg=$(cat)
  auth=$(printf '%s\n' "$cfg" | sed -n 's/^header = "\(.*\)"$/\1/p')
  body=$(printf '%s\n' "$cfg" | sed -n 's/^data-binary = "\(.*\)"$/\1/p' | sed 's/\\\\/\x01/g; s/\\"/"/g; s/\x01/\\/g')
  printf '%s %s\n%s\n\n%s\n----\n' "$m" "$path" "$auth" "$body" >> "$PWD/pid-requests"
  case "$m $path" in
    "POST /api/signup/setup")
      printf 'HTTP/1.1 200 OK\r\nSet-Cookie: __Host-access_token=TOKEN-xyz; Path=/; Max-Age=3600; HttpOnly; Secure\r\n\r\n%s' '{"id":"uid-1","username":"admin"}' ;;
    "POST /api/user-groups")
      n=$(printf '%s' "$body" | sed 's/.*"name":"\([a-z]*\)".*/\1/'); printf 'HTTP/1.1 201 Created\r\n\r\n{"id":"g-%s","name":"%s"}' "$n" "$n" ;;
    "GET /api/application-configuration/all")
      printf 'HTTP/1.1 200 OK\r\n\r\n%s' '[{"key":"appName","type":"","value":"Pocket \"ID\"","isPublic":false},{"key":"sessionDuration","type":"","value":"60","isPublic":false},{"key":"emailsVerified","type":"","value":"false","isPublic":false}]' ;;
    "POST /api/oidc/clients")
      n=$(printf '%s' "$body" | sed 's/^{"id":"\([^"]*\)".*/\1/'); s=""
      case "$body" in *'"isPublic":false'*) s=',"createdSecret":{"id":"s1","prefix":"sec","secret":"secret-'"$n"'"}' ;; esac
      printf 'HTTP/1.1 201 Created\r\n\r\n{"id":"%s","name":"%s"%s}' "$n" "$n" "$s" ;;
    "PUT "*) printf 'HTTP/1.1 200 OK\r\n\r\n{}' ;;
    *) printf 'HTTP/1.1 404 Not Found\r\n\r\n{}' ;;
  esac
}
`;

// `stack.sh up` with shims that play running, empty apps: every container is running and Pocket ID still has no user (a file
// pid-done plays a Pocket ID that has one). The shims log what
// they were sent: argv gets every docker command line, compose-env the variables the compose files read, chown-calls each chown.
// sudo skips install-restic.sh (upgrade) and sleep returns at once (upgrade's health wait).
const DOCKER_SHIM = `#!/bin/sh
log="$PWD/calls"
echo "$*" >> "$PWD/argv"
case "$*" in
  run*) printf '%s' '${FAKE_HASH}' ;;
  "inspect -f"*) echo 172.30.0.9 ;;
  *"ps -q pocket-id"*) echo cid ;;
  *"ps --status running -q"*) echo id ;;
  "rm -f"*) echo "$*" >> "$log" ;;
  *"config --services"*) echo alloy ;;
  *"compose"*" up -d"*) echo "$*" >> "$log"
    echo "OBSERVE_HUB=$OBSERVE_HUB OBSERVE_LISTEN=\${OBSERVE_LISTEN-unset} GRAFANA_OIDC_ENABLED=\${GRAFANA_OIDC_ENABLED-unset}" >> "$PWD/compose-env" ;;
  *"exec -T pocket-id /app/pocket-id one-time-access-token"*) echo "Use the following URL to sign in once: https://id.example.com/lc/TOKEN" ;;
esac
exit 0
`;
// Pocket ID answers at 172.30.0.9:1411 (above). curl-calls gets every command line.
const CURL_SHIM = `#!/bin/sh
echo "$*" >> "$PWD/curl-calls"
${PID_API_SHIM}
case "$*" in
  *"-o /dev/null http://172.30.0.9:1411/healthz") ;;
  *"-o /dev/null http://172.30.0.9:1411/api/signup/setup") if [ -f "$PWD/pid-done" ]; then exit 22; fi ;;
  *"http://172.30.0.9:1411/"*) pid_api "$@" ;;
esac
`;
// stack.sh runs as_root through sudo unless `id -u` is 0: the tests act as a non-root user even when run as root (Docker, CI)
const SHIMS = [['docker', DOCKER_SHIM], ['curl', CURL_SHIM], ['sudo', '#!/bin/sh\ncase "$*" in *install-restic*) exit 0 ;; esac\nexec "$@"\n'],
  ['id', '#!/bin/sh\n[ "$1" = -u ] && { echo 1000; exit 0; }\nexec /usr/bin/id "$@"\n'],
  ['chown', '#!/bin/sh\necho "$*" >> "$PWD/chown-calls"\n'], ['sleep', '#!/bin/sh\nexit 0\n']];
const upStandard = (env, extraFiles = {}, prep = () => {}) => runStack(env, ['up'], { extraFiles, prep });

// stack.sh ARGS in a scratch copy with the shims above; env = the .env (null: none). Fails unless it exits with `status`.
function runStack(env, args, { extraFiles = {}, prep = () => {}, status = 0 } = {}) {
  const dir = scratch();
  try {
    cpSync(new URL('config', root), join(dir, 'config'), { recursive: true });
    rmSync(join(dir, 'config/hermes/dashboard-oidc.env'), { force: true });
    if (env !== null) writeFileSync(join(dir, '.env'), env);
    for (const [f, body] of Object.entries(extraFiles)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), body);
    }
    prep(dir);
    mkdirSync(join(dir, 'bin'));
    for (const [cmd, body] of SHIMS) {
      writeFileSync(join(dir, 'bin', cmd), body);
      chmodSync(join(dir, 'bin', cmd), 0o755);
    }
    const r = spawnSync('bash', ['stack.sh', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } });
    assert.equal(r.status, status, r.stderr);
    const names = ['calls', 'pid-requests', 'argv', '.env', 'config/hermes/dashboard-oidc.env', 'curl-calls', 'compose-env',
      'chown-calls', 'data/alloy/probes.yml', 'data/versions.applied'];
    const files = Object.fromEntries(names.map((f) => [f, existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '']));
    const exists = Object.fromEntries(names.map((f) => [f, existsSync(join(dir, f))]));
    const envMode = existsSync(join(dir, '.env')) ? statSync(join(dir, '.env')).mode & 0o777 : null;
    const leftovers = readdirSync(dir).filter((f) => f.startsWith('.env.') && f !== '.env.example');
    return { out: r.stdout, err: r.stderr, read: (f) => files[f], exists: (f) => exists[f], envMode, leftovers };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const STANDARD_ENV = 'DOMAIN=example.com\nSTACK_TIER=standard\nADMIN_EMAIL=me@example.com\nOBSERVE_HUB=observe-hub\n';

test('up creates the first admin of Pocket ID with ADMIN_EMAIL', { skip: !hasBash }, () => {
  const { out, read } = upStandard(STANDARD_ENV);
  assert.deepEqual(pidBody(pidRequests(read), 'POST /api/signup/setup'), { username: 'admin', email: 'me@example.com', firstName: 'Admin' });
  for (const line of ['Pocket ID: admin created', 'https://id.example.com/lc/TOKEN']) assert.ok(out.includes(line), `missing: ${line}`);
});

test('up leaves the setup page alone while ADMIN_EMAIL is empty', { skip: !hasBash }, () => {
  const { out, read } = upStandard(STANDARD_ENV.replace('ADMIN_EMAIL=me@example.com\n', ''));
  assert.equal(read('pid-requests'), '');
  assert.ok(!out.includes('created'));
});

// The requests the Pocket ID shim got, as { line: "METHOD PATH", auth, body }
function pidRequests(read) {
  return read('pid-requests').split('\n----\n').filter(Boolean).map((r) => {
    const [line, auth, , ...body] = r.split('\n');
    return { line, auth, body: body.join('\n') };
  });
}
const pidBody = (reqs, line) => JSON.parse(reqs.find((r) => r.line === line)?.body ?? 'null');
const OIDC_ENV = STANDARD_ENV + 'CF_TEAM_NAME=myteam\nOPENWEBUI_OIDC_CLIENT_ID=\nOPENWEBUI_OIDC_CLIENT_SECRET=\nTZ=UTC\n';

test('up sets up Pocket ID with the new admin\'s session: groups, verified email, emails verified by default, 1-day sessions', { skip: !hasBash }, () => {
  const { read } = upStandard(OIDC_ENV);
  const reqs = pidRequests(read);
  assert.equal(reqs[0].auth, '', 'the setup call has no session yet');
  for (const r of reqs.slice(1)) assert.equal(r.auth, 'Authorization: Bearer TOKEN-xyz', `${r.line} without the session`);
  assert.ok(!(read('argv') + read('curl-calls')).includes('TOKEN-xyz'), 'the session token never goes on a command line');
  assert.deepEqual(pidBody(reqs, 'POST /api/user-groups'), { friendlyName: 'Admins', name: 'admins' });
  assert.ok(reqs.some((r) => r.line === 'POST /api/user-groups' && JSON.parse(r.body).name === 'members'));
  assert.deepEqual(pidBody(reqs, 'PUT /api/users/uid-1/user-groups'), { userGroupIds: ['g-admins'] });
  assert.deepEqual(pidBody(reqs, 'PUT /api/application-configuration'),
    { appName: 'Pocket "ID"', sessionDuration: '1440', emailsVerified: 'true' });
  assert.deepEqual(pidBody(reqs, 'PUT /api/users/uid-1'),
    { username: 'admin', email: 'me@example.com', emailVerified: true, firstName: 'Admin', displayName: 'Admin', isAdmin: true });
});

test('up creates the four OIDC clients of IDENTITY.md with their callbacks, flags and groups', { skip: !hasBash }, () => {
  const { read } = upStandard(OIDC_ENV);
  const reqs = pidRequests(read);
  const clients = Object.fromEntries(reqs.filter((r) => r.line === 'POST /api/oidc/clients').map((r) => [JSON.parse(r.body).id, JSON.parse(r.body)]));
  const want = {
    'open-webui': ['https://chat.example.com/oauth/oidc/callback', false, ['g-admins', 'g-members']],
    'hermes-dashboard': ['https://hermes.example.com/auth/callback', true, ['g-admins']],
    grafana: ['https://monitor.example.com/login/generic_oauth', false, ['g-admins']],
    'cloudflare-access': ['https://myteam.cloudflareaccess.com/cdn-cgi/access/callback', false, ['g-admins', 'g-members']],
  };
  assert.deepEqual(Object.keys(clients).sort(), Object.keys(want).sort());
  for (const [id, [cb, isPublic, groups]] of Object.entries(want)) {
    assert.deepEqual(clients[id], { id, name: id, callbackURLs: [cb], isPublic, pkceEnabled: true, isGroupRestricted: true });
    assert.deepEqual(pidBody(reqs, `PUT /api/oidc/clients/${id}/allowed-user-groups`), { userGroupIds: groups });
  }
});

test('up keeps every client secret in .env (F2 and F3 come days later), writes the Hermes client, and restarts both apps', { skip: !hasBash }, () => {
  const { out, read } = upStandard(OIDC_ENV);
  const env = read('.env');
  assert.match(env, /\nOPENWEBUI_OIDC_CLIENT_ID=open-webui\nOPENWEBUI_OIDC_CLIENT_SECRET=secret-open-webui\nTZ=UTC\n/, 'set in place');
  assert.equal(env.match(/^OPENWEBUI_OIDC_CLIENT_(ID|SECRET)=/gm).length, 2);
  assert.match(env, /^GRAFANA_OIDC_CLIENT_SECRET=secret-grafana$/m);
  assert.match(env, /^ACCESS_OIDC_CLIENT_SECRET=secret-cloudflare-access$/m);
  assert.match(read('config/hermes/dashboard-oidc.env'), /^HERMES_DASHBOARD_OIDC_ISSUER=https:\/\/id\.example\.com\nHERMES_DASHBOARD_OIDC_CLIENT_ID=hermes-dashboard$/m);
  assert.ok(!/secret-[a-z-]+/.test(out), 'no secret on the terminal');
  assert.match(read('calls'), /compose up -d --remove-orphans\n[^]*compose up -d open-webui\ncompose up -d hermes\n/);
  assert.ok(out.indexOf('OIDC clients created') < out.indexOf('https://id.example.com/lc/TOKEN'), 'the passkey link comes last');
});

test('up skips the cloudflare-access client while CF_TEAM_NAME is empty', { skip: !hasBash }, () => {
  const { out, read } = upStandard(OIDC_ENV.replace('CF_TEAM_NAME=myteam\n', ''));
  assert.ok(!read('pid-requests').includes('cloudflare-access'));
  assert.ok(out.includes('No CF_TEAM_NAME in .env'));
  assert.ok(!read('.env').includes('ACCESS_OIDC_CLIENT_SECRET='));
  assert.match(read('.env'), /^GRAFANA_OIDC_CLIENT_SECRET=secret-grafana$/m);
});

test('up leaves a Pocket ID that has its admin alone', { skip: !hasBash }, () => {
  const { out, read } = upStandard(OIDC_ENV, { 'pid-done': '' });
  assert.equal(read('pid-requests'), '');
  assert.ok(!out.includes('Pocket ID'));
  assert.match(read('.env'), /\nOPENWEBUI_OIDC_CLIENT_ID=\n/);
  assert.equal(read('config/hermes/dashboard-oidc.env'), '');
});

test('the launcher keeps every link for the standard tier and fills in the domain', { skip: !hasBash }, () => {
  const out = renderDash('standard', 'example.com');
  for (const name of ['n8n', 'OmniRoute', 'Hermes', 'Open WebUI', 'Grafana', 'Pocket ID', 'Cloudflare dashboard']) assert.ok(out.includes(`name: "${name}"`), `missing ${name}`);
  assert.ok(out.includes('https://monitor.example.com'));
  assert.ok(out.includes('https://n8n.example.com'));
  assert.ok(!out.includes('{{DOMAIN}}'));
});

test('the launcher drops the links of components the tier does not run, and groups left empty', { skip: !hasBash }, () => {
  const out = renderDash('lite');
  assert.ok(out.includes('name: "Pocket ID"'));
  const small = renderDash('n8n-only');
  for (const gone of ['OmniRoute', 'Hermes', 'Open WebUI', 'Grafana', 'Pocket ID', 'Identity', 'Monitoring']) assert.ok(!small.includes(`name: "${gone}"`), `${gone} should be gone`);
  assert.ok(small.includes('name: "n8n"'));
  assert.ok(small.includes('name: "Automation and AI"'));
  assert.ok(small.includes('name: "Cloudflare dashboard"'));
});

// ---- Monitoring: the observe project, the service checks, the hub

test('up writes the service checks of the tier for Alloy, with the domain filled in', { skip: !hasBash }, () => {
  const { read } = upStandard(STANDARD_ENV);
  const probes = read('data/alloy/probes.yml');
  const rows = [...probes.matchAll(/^- targets: \[("[^"]+")\]\n {2}labels: \{probe: ("[^"]+"), module: ([a-z0-9_]+)\}$/gm)]
    .map(([, t, p, m]) => [JSON.parse(p), JSON.parse(t), m]);
  assert.equal(rows.length, probes.trim().split('\n').length / 2, 'every line is a target or its labels');
  const names = rows.map((r) => r[0]);
  for (const n of ['n8n', 'n8n via Cloudflare', 'OmniRoute', 'Hermes gateway', 'Open WebUI', 'SearXNG', 'Crawl4AI', 'cloudflared', 'Homer', 'Pocket ID']) assert.ok(names.includes(n), `missing ${n}`);
  assert.ok(!names.includes('Postgres') && !names.includes('Valkey'), 'not in the standard tier');
  assert.deepEqual(rows.find((r) => r[0] === 'Pocket ID'), ['Pocket ID', 'https://id.example.com/healthz', 'http_2xx']);
  assert.deepEqual(rows.find((r) => r[0] === 'Hermes gateway'), ['Hermes gateway', 'http://hermes:9119/api/status', 'http_gateway_running']);
});

test('a tier without blackbox gets an empty check list', { skip: !hasBash }, () => {
  const { read } = upStandard('DOMAIN=example.com\nSTACK_TIER=n8n-only\n');
  assert.equal(read('data/alloy/probes.yml'), '[]\n');
});

test('every check module stack.sh names exists in config/observe/blackbox.yml', () => {
  const sh = readFileSync(new URL('stack.sh', root), 'utf8');
  const modules = new Set([...sh.match(/^PROBES='([^']*)'/m)[1].split('\n')].map((l) => l.split('|')[2]));
  const bb = readFileSync(new URL('config/observe/blackbox.yml', root), 'utf8');
  for (const m of modules) assert.match(bb, new RegExp(`^ {2}${m}:$`, 'm'), `${m} is not a module`);
});

test('the app host runs the observe project with the attach file, and Alloy is pointed at the hub', { skip: !hasBash }, () => {
  const { err, read } = upStandard(STANDARD_ENV);
  assert.match(read('argv'), /compose -f docker-compose\.observe\.yml -f docker-compose\.observe\.attach\.yml up -d --remove-orphans/);
  assert.ok(read('compose-env').includes('OBSERVE_HUB=observe-hub OBSERVE_LISTEN=unset GRAFANA_OIDC_ENABLED=unset'), 'no Docker hub variables any more');
  assert.ok(!err.includes('OBSERVE_HUB is empty'));
  const empty = upStandard(STANDARD_ENV.replace('OBSERVE_HUB=observe-hub\n', ''));
  assert.ok(empty.err.includes('Alloy: OBSERVE_HUB is empty'), 'warned, not stopped: the hub may come later');
});

test('an agent host runs only the observe project, without the app networks', { skip: !hasBash }, () => {
  const { read } = upStandard('DOMAIN=example.com\nSTACK_TIER=agent\nOBSERVE_HUB=observe-hub\n');
  const ups = read('calls').split('\n').filter((l) => / up -d --remove-orphans$/.test(l));
  assert.deepEqual(ups, ['compose -f docker-compose.observe.yml up -d --remove-orphans']);
});

test('the backup writes its result for Alloy, and a failed run keeps the last success', { skip: !hasBash }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-'));
  try {
    const fn = readFileSync(new URL('backup/backup.sh', root), 'utf8').match(/^backup_metric\(\) \{[^]*?^\}$/m)[0];
    const run = (arg) => spawnSync('bash', ['-c', `set -Eeuo pipefail; log() { :; }; err() { :; }; STACK_DIR="$1"; ${fn}\nbackup_metric ${arg}`, 'x', dir], { encoding: 'utf8' });
    assert.equal(run(1).status, 0);
    const prom = () => readFileSync(join(dir, 'data/alloy/textfile/backup.prom'), 'utf8');
    const ok = /^stack_backup_last_success_timestamp_seconds (\d+)$/m.exec(prom())[1];
    assert.match(prom(), /^stack_backup_success 1$/m);
    assert.equal(run(0).status, 0);
    assert.match(prom(), /^stack_backup_success 0$/m);
    assert.match(prom(), new RegExp(`^stack_backup_last_success_timestamp_seconds ${ok}$`, 'm'));
    assert.match(prom(), /^stack_backup_last_run_timestamp_seconds \d+$/m);
    assert.deepEqual(readdirSync(join(dir, 'data/alloy/textfile')), ['backup.prom'], 'no temporary file left for the collector');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Commands, flags and exit codes

test('an unknown command prints the usage on stderr and exits 2; help prints it on stdout and exits 0', { skip: !hasBash }, () => {
  const bad = spawnSync('bash', ['stack.sh', 'bogus'], { cwd: fileURLToPath(root), encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown command: bogus[^]*Usage:/);
  assert.equal(bad.stdout, '');
  for (const h of ['help', '-h', undefined]) {
    const ok = spawnSync('bash', ['stack.sh', ...(h ? [h] : [])], { cwd: fileURLToPath(root), encoding: 'utf8' });
    assert.equal(ok.status, 0, String(h));
    assert.match(ok.stdout, /^Usage:[^]*Exit codes: 0 ok, 1 error, 2 usage/);
  }
});

test('upgrade and tier refuse unknown flags with exit 2, before touching anything', { skip: !hasBash }, () => {
  const up = runStack(STANDARD_ENV, ['upgrade', '--no-bakup'], { status: 2 });
  assert.match(up.err, /unknown argument: --no-bakup/);
  assert.equal(up.read('argv'), '');
  const tier = runStack(STANDARD_ENV, ['tier', 'lite', '--hrad'], { status: 2 });
  assert.match(tier.err, /unknown flag: --hrad/);
  assert.match(tier.read('.env'), /^STACK_TIER=standard$/m);
  runStack(STANDARD_ENV, ['tier'], { status: 2 });
});

// ---- .env writes (set_env)

test('a .env whose last line has no newline gets the new line on a line of its own, privately, with no temp file left', { skip: !hasBash }, () => {
  const r = upStandard('DOMAIN=example.com\nSTACK_TIER=n8n-only\nADMIN_EMAIL=me@example.com\nN8N_OWNER_PASSWORD=pw-secret');
  const env = r.read('.env');
  assert.match(env, /\nN8N_OWNER_PASSWORD=pw-secret\n[A-Z]/, 'the next line starts on its own');
  assert.equal(env.match(/^N8N_OWNER_PASSWORD_HASH='[^'\n]+'$/gm).length, 1);
  assert.ok(env.endsWith('\n'));
  for (const l of env.slice(0, -1).split('\n')) assert.match(l, /^[A-Z0-9_]+=/, 'every line is KEY=VALUE');
  assert.deepEqual(r.leftovers, []);
  if (process.platform !== 'win32') assert.equal(r.envMode, 0o600);
});

test('the n8n owner password reaches docker run by name, never on its command line', { skip: !hasBash }, () => {
  const { read } = upStandard('DOMAIN=example.com\nSTACK_TIER=n8n-only\nADMIN_EMAIL=me@example.com\nN8N_OWNER_PASSWORD=pw-secret\n');
  assert.match(read('argv'), /^run --rm -e PW -e HASH /m);
  assert.ok(!read('argv').includes('pw-secret'));
});

test('tier adds STACK_TIER to a .env that has none, and needs a .env', { skip: !hasBash }, () => {
  const r = runStack('DOMAIN=example.com\nOBSERVE_HUB=observe-hub', ['tier', 'n8n-only']);
  assert.ok(r.read('.env').startsWith('DOMAIN=example.com\nOBSERVE_HUB=observe-hub\nSTACK_TIER=n8n-only\n'), r.read('.env'));
  assert.equal(r.read('.env').match(/^STACK_TIER=/gm).length, 1);
  const none = runStack(null, ['tier', 'n8n-only'], { status: 1 });
  assert.match(none.err, /No \.env found/);
  assert.ok(!none.exists('.env'));
});

// ---- resume (backup.sh) and mark_applied

test('resume only runs docker compose up -d per project: no admin setup, hash sync, migration or applied versions', { skip: !hasBash }, () => {
  const r = runStack(STANDARD_ENV + 'N8N_OWNER_PASSWORD=pw\n', ['resume']);
  const ups = r.read('calls').split('\n').filter(Boolean);
  assert.deepEqual(ups, ['compose up -d', 'compose -f docker-compose.observe.yml -f docker-compose.observe.attach.yml up -d']);
  assert.equal(r.read('pid-requests'), '');
  assert.equal(r.read('curl-calls'), '', 'first_admins not called');
  assert.ok(!/^run /m.test(r.read('argv')), 'no n8n hash container');
  assert.ok(!r.read('.env').includes('N8N_OWNER_PASSWORD_HASH'));
  assert.ok(!r.exists('data/versions.applied'));
  const scoped = runStack(STANDARD_ENV, ['observe', 'resume']);
  assert.deepEqual(scoped.read('calls').split('\n').filter(Boolean), ['compose -f docker-compose.observe.yml -f docker-compose.observe.attach.yml up -d']);
});

test('tier and upgrade record the applied versions only when they acted on every project', { skip: !hasBash }, () => {
  assert.ok(!runStack(STANDARD_ENV, ['apps', 'tier', 'standard']).exists('data/versions.applied'));
  assert.ok(runStack(STANDARD_ENV, ['tier', 'standard']).exists('data/versions.applied'));
  assert.ok(!runStack(STANDARD_ENV, ['observe', 'upgrade', '--no-backup']).exists('data/versions.applied'));
  assert.ok(runStack(STANDARD_ENV, ['upgrade', '--no-backup']).exists('data/versions.applied'));
});

test('the backup stops only the apps, if they run, and resumes them, never with stack.sh start or up; observe keeps running', { skip: !hasBash }, () => {
  const sh = readFileSync(new URL('backup/backup.sh', root), 'utf8');
  assert.ok(!/stack\.sh"? (start|up)\b/.test(sh), 'no full start after the snapshot');
  const fns = ['running_scopes', 'stop_running', 'resume_stopped'].map((n) => sh.match(new RegExp(`^${n}\\(\\) \\{[^]*?^\\}$`, 'm'))[0]).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'backup-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'docker'), '#!/bin/sh\ncase "$*" in *project=stack) [ -f "$D/run-stack" ] && echo a ;; *project=observe) [ -f "$D/run-observe" ] && echo b ;; esac\nexit 0\n');
    writeFileSync(join(dir, 'stack.sh'), '#!/bin/sh\necho "$*" >> "$D/stack-calls"\n');
    for (const f of ['bin/docker', 'stack.sh']) chmodSync(join(dir, f), 0o755);
    const run = (running) => {
      rmSync(join(dir, 'stack-calls'), { force: true });
      for (const p of ['stack', 'observe']) rmSync(join(dir, `run-${p}`), { force: true });
      for (const p of running) writeFileSync(join(dir, `run-${p}`), '');
      const r = spawnSync('bash', ['-c', `set -Eeuo pipefail; log() { :; }; err() { :; }; export D="$PWD"; STACK_DIR="$D"; PATH="$D/bin:$PATH"\n${fns}\nstopped=()\nstop_running\nresume_stopped`],
        { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return existsSync(join(dir, 'stack-calls')) ? readFileSync(join(dir, 'stack-calls'), 'utf8').split('\n').filter(Boolean) : [];
    };
    assert.deepEqual(run(['stack', 'observe']), ['apps stop', 'apps resume']);
    assert.deepEqual(run(['stack']), ['apps stop', 'apps resume']);
    assert.deepEqual(run(['observe']), []);
    assert.deepEqual(run([]), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
