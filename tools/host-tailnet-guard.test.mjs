import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const hasBash = spawnSync('bash', ['--version']).status === 0;
const installer = readFileSync(fileURLToPath(new URL('host/tailnet-guard.sh', root)), 'utf8');

// The installer writes to fixed system paths (/usr/local/sbin, /etc/systemd/system) and refuses to run without root,
// so the tests run the heredoc body it writes (the guard script) from a temp dir instead of running the installer.
function guardBody() {
  const m = installer.match(/cat >\/usr\/local\/sbin\/stack-tailnet-guard <<'EOF'\n([\s\S]*?)\nEOF\n/);
  assert.ok(m, 'host/tailnet-guard.sh no longer writes stack-tailnet-guard from a heredoc');
  return m[1] + '\n';
}

const RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'];
const PORTS = [9090, 3100, 4317, 4318];

// Fake iptables/ip6tables. Each call is appended to $STATE/calls.log. A chain is a file $STATE/<table>/<chain> with one
// rule per line. -N -F -X -A -I -C -D and -n -L fail or succeed the way iptables does for these chains.
function tableShim(table) {
  return `#!/bin/sh
D="$STATE/${table}"
mkdir -p "$D"
printf '%s\\n' "${table} $*" >> "$STATE/calls.log"
if [ "$1" = -n ]; then [ -f "$D/$3" ]; exit $?; fi
op=$1; chain=$2; shift 2
f="$D/$chain"; rule="$*"
case "$op" in
  -N) if [ -f "$f" ]; then exit 1; fi; : > "$f" ;;
  -F) [ -f "$f" ] || exit 1; : > "$f" ;;
  -X) [ -f "$f" ] || exit 1; if [ -s "$f" ]; then exit 1; fi; rm -f "$f" ;;
  -A) [ -f "$f" ] || exit 1; printf '%s\\n' "$rule" >> "$f" ;;
  -I) [ -f "$f" ] || exit 1; { printf '%s\\n' "$rule"; cat "$f"; } > "$f.tmp" && mv "$f.tmp" "$f" ;;
  -C) [ -f "$f" ] && grep -qxF -- "$rule" "$f" ;;
  -D) [ -f "$f" ] && grep -qxF -- "$rule" "$f" || exit 1
      first=1; : > "$f.tmp"
      while IFS= read -r line; do
        if [ "$first" = 1 ] && [ "$line" = "$rule" ]; then first=0; continue; fi
        printf '%s\\n' "$line" >> "$f.tmp"
      done < "$f"
      mv "$f.tmp" "$f" ;;
  *) echo "fake ${table}: unsupported $op" >&2; exit 2 ;;
esac
`;
}

function writeExecutable(path, text) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

// A scratch host: iptables (and ip6tables) with DOCKER-USER present or absent, and the guard script in place.
function setup({ docker = true, ip6 = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-guard-'));
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  mkdirSync(bin);
  mkdirSync(state);
  const tables = ip6 ? ['iptables', 'ip6tables'] : ['iptables'];
  for (const t of tables) {
    writeExecutable(join(bin, t), tableShim(t));
    mkdirSync(join(state, t));
    // Docker's own chain ends in RETURN; the guard's jump must go in above it.
    if (docker) writeFileSync(join(state, t, 'DOCKER-USER'), '-j RETURN\n');
  }
  const guard = join(dir, 'stack-tailnet-guard');
  writeExecutable(guard, guardBody());
  // Drop host PATH dirs that carry a real ip6tables, so "no ip6tables" holds on any machine.
  const hostPath = (process.env.PATH ?? '').split(delimiter).filter((d) => d && !existsSync(join(d, 'ip6tables')));
  const env = { ...process.env, PATH: [bin, ...hostPath].join(delimiter), STATE: state };
  return {
    run: (...args) => spawnSync('sh', [guard, ...args], { env, encoding: 'utf8' }),
    state,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// Lines of a chain as the shim holds them, or null when the chain does not exist.
function chain(state, table, name) {
  const f = join(state, table, name);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : null;
}

// Every shim call in order, as "table args...".
function calls(state) {
  const f = join(state, 'calls.log');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
}

// Parse one rule line into the fields the guard uses.
function parseRule(line) {
  const t = line.trim().split(/\s+/);
  const r = { in: null, out: null, proto: null, dports: null, states: null, origdst: null, target: null };
  for (let i = 0; i < t.length; i++) {
    let neg = false;
    if (t[i] === '!') { neg = true; i++; }
    switch (t[i]) {
      case '-i': r.in = { neg, name: t[++i] }; break;
      case '-o': r.out = t[++i]; break;
      case '-p': r.proto = t[++i]; break;
      case '-m': i++; break;
      case '--dports': r.dports = t[++i].split(','); break;
      case '--ctstate': r.states = t[++i].split(','); break;
      case '--ctorigdst': r.origdst = t[++i]; break;
      case '-j': r.target = t[++i]; break;
      default: throw new Error(`unhandled rule token "${t[i]}" in: ${line}`);
    }
  }
  return r;
}

// Interface match with iptables' trailing "+" wildcard.
function ifMatch(pattern, name) {
  if (name === undefined) return false;
  return pattern.endsWith('+') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

// IPv4 CIDR membership.
function inCidr(ip, cidr) {
  const [net, bits] = cidr.split('/');
  const n = Number(bits);
  const v4 = (a) => a.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
  const mask = n === 0 ? 0 : 2 ** 32 - 2 ** (32 - n);
  return ((v4(ip) & mask) >>> 0) === ((v4(net) & mask) >>> 0);
}

function matches(r, p) {
  if (r.in && ifMatch(r.in.name, p.in) === r.in.neg) return false;
  if (r.out && !ifMatch(r.out, p.out)) return false;
  if (r.proto && r.proto !== p.proto) return false;
  if (r.dports && !r.dports.includes(String(p.dport))) return false;
  if (r.states && !r.states.includes(p.state)) return false;
  if (r.origdst && !inCidr(p.dst, r.origdst)) return false;
  return true;
}

// The target of the first matching rule in the chain, or null when none matches (the packet falls through).
function verdict(rules, p) {
  for (const r of rules) if (matches(r, p)) return r.target;
  return null;
}

const rulesOf = (lines) => lines.map(parseRule);
const container = (dst, dport, extra = {}) => ({ in: 'br-1a2b3c', out: 'ens3', proto: 'tcp', dport, state: 'NEW', dst, ...extra });

test('start fills STACK-TAILNET with the docker RETURN rules first, then one REJECT rule per private range, and jumps to it from the top of DOCKER-USER', { skip: !hasBash }, () => {
  const h = setup({ ip6: false });
  try {
    const r = h.run('start');
    assert.equal(r.status, 0, r.stderr);
    const ops = calls(h.state).map((l) => l.split(' ').slice(1));
    assert.deepEqual(ops.map((a) => a[0]), ['-n', '-N', '-F', '-A', '-A', '-A', '-A', '-A', '-A', '-C', '-I']);
    assert.deepEqual(ops[0], ['-n', '-L', 'DOCKER-USER']);
    assert.deepEqual(ops.at(-1), ['-I', 'DOCKER-USER', '-j', 'STACK-TAILNET']);

    const lines = chain(h.state, 'iptables', 'STACK-TAILNET');
    assert.deepEqual(lines.slice(0, 2), ['-o docker0 -j RETURN', '-o br-+ -j RETURN']);
    const rejects = rulesOf(lines.slice(2));
    assert.equal(rejects.length, RANGES.length);
    RANGES.forEach((range, i) => {
      const rule = rejects[i];
      assert.equal(rule.target, 'REJECT');
      assert.equal(rule.origdst, range);
      assert.deepEqual(rule.dports, PORTS.map(String));
      assert.equal(rule.proto, 'tcp');
      assert.deepEqual(rule.states, ['NEW']);
      assert.deepEqual(rule.in, { neg: true, name: 'tailscale0' });
    });
    assert.deepEqual(chain(h.state, 'iptables', 'DOCKER-USER'), ['-j STACK-TAILNET', '-j RETURN']);
  } finally { h.cleanup(); }
});

test('the filled chain rejects container traffic to the hub ports on every private and tailnet range, and only that', { skip: !hasBash }, () => {
  const h = setup({ ip6: false });
  try {
    assert.equal(h.run('start').status, 0);
    const rules = rulesOf(chain(h.state, 'iptables', 'STACK-TAILNET'));
    const hostsInRanges = ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.168.255.254', '100.64.0.1', '100.127.255.254'];
    for (const dst of hostsInRanges) {
      for (const dport of PORTS) assert.equal(verdict(rules, container(dst, dport)), 'REJECT', `${dst}:${dport}`);
    }
    // Outside the hub ports, outside the ranges, or not a new connection: not rejected here.
    assert.equal(verdict(rules, container('8.8.8.8', 9090)), null);
    assert.equal(verdict(rules, container('10.0.0.5', 22)), null);
    assert.equal(verdict(rules, container('100.128.0.1', 9090)), null);
    assert.equal(verdict(rules, container('172.32.0.1', 9090)), null);
    assert.equal(verdict(rules, container('10.0.0.5', 9090, { state: 'ESTABLISHED' })), null);
    // Container to container on a Docker bridge returns before any REJECT, even inside a private range.
    assert.equal(verdict(rules, { in: 'br-1a2b3c', out: 'docker0', proto: 'tcp', dport: 9090, state: 'NEW', dst: '172.17.0.5' }), 'RETURN');
    assert.equal(verdict(rules, { in: 'docker0', out: 'br-9f8e7d', proto: 'tcp', dport: 9090, state: 'NEW', dst: '172.18.0.3' }), 'RETURN');
    // Tailnet traffic arriving on tailscale0 is not rejected.
    assert.equal(verdict(rules, { in: 'tailscale0', out: 'ens3', proto: 'tcp', dport: 9090, state: 'NEW', dst: '10.0.0.5' }), null);
  } finally { h.cleanup(); }
});

test('start exits 1 with an error when iptables has no DOCKER-USER chain, and changes no rules', { skip: !hasBash }, () => {
  const h = setup({ docker: false, ip6: true });
  try {
    const r = h.run('start');
    assert.equal(r.status, 1);
    assert.notEqual(r.stderr.trim(), '');
    assert.equal(chain(h.state, 'iptables', 'STACK-TAILNET'), null);
    assert.equal(chain(h.state, 'ip6tables', 'STACK-TAILNET'), null);
    assert.equal(chain(h.state, 'iptables', 'DOCKER-USER'), null);
    assert.deepEqual(calls(h.state).filter((l) => / -(N|F|A|I|X|C|D) /.test(l)), []);
  } finally { h.cleanup(); }
});

test('start on a host without ip6tables fills IPv4 and does not touch IPv6', { skip: !hasBash }, () => {
  const h = setup({ ip6: false });
  try {
    const r = h.run('start');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(rulesOf(chain(h.state, 'iptables', 'STACK-TAILNET')).length, 2 + RANGES.length);
    assert.deepEqual(calls(h.state).filter((l) => l.startsWith('ip6tables ')), []);
  } finally { h.cleanup(); }
});

test('start with ip6tables running DOCKER-USER also fills the IPv6 chain for fc00::/7', { skip: !hasBash }, () => {
  const h = setup({ ip6: true });
  try {
    const r = h.run('start');
    assert.equal(r.status, 0, r.stderr);
    const v6 = chain(h.state, 'ip6tables', 'STACK-TAILNET');
    assert.deepEqual(v6.slice(0, 2), ['-o docker0 -j RETURN', '-o br-+ -j RETURN']);
    const [rule] = rulesOf(v6.slice(2));
    assert.equal(v6.length, 3);
    assert.equal(rule.target, 'REJECT');
    assert.equal(rule.origdst, 'fc00::/7');
    assert.deepEqual(rule.dports, PORTS.map(String));
    assert.deepEqual(chain(h.state, 'ip6tables', 'DOCKER-USER'), ['-j STACK-TAILNET', '-j RETURN']);
    assert.equal(chain(h.state, 'iptables', 'STACK-TAILNET').length, 2 + RANGES.length);
  } finally { h.cleanup(); }
});

test('stop removes the jump and the chain in both tables, and leaves DOCKER-USER as Docker had it', { skip: !hasBash }, () => {
  const h = setup({ ip6: true });
  try {
    assert.equal(h.run('start').status, 0);
    const r = h.run('stop');
    assert.equal(r.status, 0, r.stderr);
    for (const t of ['iptables', 'ip6tables']) {
      assert.equal(chain(h.state, t, 'STACK-TAILNET'), null, `${t} STACK-TAILNET`);
      assert.deepEqual(chain(h.state, t, 'DOCKER-USER'), ['-j RETURN'], `${t} DOCKER-USER`);
    }
    assert.equal(h.run('stop').status, 0, 'stop with nothing to undo');
  } finally { h.cleanup(); }
});

test('an unknown or missing argument exits 2 and touches no rules', { skip: !hasBash }, () => {
  const h = setup({ ip6: true });
  try {
    for (const args of [['bogus'], ['--help'], []]) {
      const r = h.run(...args);
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.notEqual(r.stderr.trim(), '', JSON.stringify(args));
    }
    assert.deepEqual(calls(h.state), []);
    assert.deepEqual(chain(h.state, 'iptables', 'DOCKER-USER'), ['-j RETURN']);
    assert.equal(chain(h.state, 'iptables', 'STACK-TAILNET'), null);
  } finally { h.cleanup(); }
});

test('running start twice leaves the same rules, with a single jump from DOCKER-USER', { skip: !hasBash }, () => {
  const h = setup({ ip6: true });
  try {
    assert.equal(h.run('start').status, 0);
    const snapshot = () => ['iptables', 'ip6tables'].map((t) => [chain(h.state, t, 'STACK-TAILNET'), chain(h.state, t, 'DOCKER-USER')]);
    const first = snapshot();
    const r = h.run('start');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(snapshot(), first);
    assert.equal(chain(h.state, 'iptables', 'DOCKER-USER').filter((l) => l === '-j STACK-TAILNET').length, 1);
  } finally { h.cleanup(); }
});
