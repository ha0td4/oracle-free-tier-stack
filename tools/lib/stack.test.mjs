import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMem, parseCompose, parseTierEnv, planTier } from './stack.mjs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const services = parseCompose(['docker-compose.yml', 'docker-compose.observe.yml'].map(read).join('\n'));
const tier = (name) => parseTierEnv(read(`tiers/${name}.env`));

test('parseMem converts Docker memory strings to MiB', () => {
  assert.equal(parseMem('128m'), 128);
  assert.equal(parseMem('1g'), 1024);
  assert.equal(parseMem('1536m'), 1536);
  assert.equal(parseMem('2G'), 2048);
});


test('parseCompose reads every service with its profiles and memory limit', () => {
  const byName = Object.fromEntries(services.map((s) => [s.name, s]));
  assert.equal(services.length, 14);
  assert.deepEqual(byName['open-webui'].profiles, ['open-webui']);
  assert.equal(byName['open-webui'].memVar, 'MEM_OPENWEBUI');
  assert.deepEqual(byName.cloudflared.profiles, []);
  assert.deepEqual(byName.n8n.profiles, ['n8n']);
  assert.equal(byName.cloudflared.memVar, 'MEM_CLOUDFLARED');
  assert.deepEqual(byName.hermes.profiles, ['hermes']);
  assert.deepEqual(byName['socket-proxy'].profiles, ['alloy']);
  assert.deepEqual(byName.alloy.profiles, ['alloy']);
  assert.equal(byName.alloy.memVar, 'MEM_ALLOY');
  assert.equal(byName.n8n.memVar, 'MEM_N8N');
  assert.equal(byName.n8n.memDefault, 1024);
  assert.equal(byName.blackbox.memVar, 'MEM_BLACKBOX');
  assert.equal(byName.blackbox.memDefault, 32);
});

test('every memory limit can be changed from a tier (MEM_<NAME>), and the defaults are the standard tier', () => {
  for (const s of services) assert.ok(s.memVar, `${s.name}: hard-coded mem_limit`);
  const std = tier('standard').vars;
  for (const s of services) if (std[s.memVar]) assert.equal(s.memDefault, Number.parseInt(std[s.memVar], 10) * (/g$/.test(std[s.memVar]) ? 1024 : 1), `${s.name}: default differs from the standard tier`);
});

test('parseTierEnv reads profiles and limit overrides', () => {
  const t = tier('standard');
  assert.ok(t.profiles.includes('hermes'));
  assert.equal(t.vars.MEM_HERMES, '3g');
});

test('every profile named in a tier exists in the compose file', () => {
  const known = new Set(services.flatMap((s) => s.profiles));
  for (const name of ['standard', 'full', 'lite', 'agent']) {
    for (const p of tier(name).profiles) assert.ok(known.has(p), `${name}: unknown profile ${p}`);
  }
});

test('a tier sets limits only for services it runs', () => {
  for (const name of ['standard', 'full', 'lite', 'agent']) {
    const t = tier(name);
    const active = planTier(services, t).services.map((s) => s.name);
    const owners = (v) => services.filter((s) => s.memVar === v || s.cpusVar === v).map((s) => s.name);
    for (const v of Object.keys(t.vars).filter((k) => /^(MEM|CPU)_/.test(k))) {
      assert.ok(owners(v).some((n) => active.includes(n)), `${name}: ${v} limits a service the tier does not run`);
    }
  }
});

test('each component profile is named after a service, shared helpers list their components', () => {
  const names = new Set(services.map((s) => s.name));
  for (const s of services) {
    for (const p of s.profiles) assert.ok(names.has(p), `${s.name}: profile ${p} is not a service name`);
  }
});

test('the agent tier runs only Alloy and its socket-proxy, and no app stack', () => {
  const t = tier('agent');
  assert.equal(t.vars.STACK_APPS, '0');
  const plan = planTier(services.filter((s) => s.name !== 'cloudflared'), t);
  assert.deepEqual(plan.services.map((s) => s.name).sort(), ['alloy', 'socket-proxy']);
});

test('the dashboards use the data source uids that the native hub provisions', () => {
  const hub = read('host/hub/deploy-hub.sh');
  const uids = new Set([...hub.matchAll(/^ {4}uid: ([a-z]+)$/gm)].map((m) => m[1]));
  for (const u of ['prometheus', 'loki']) assert.ok(uids.has(u), `deploy-hub.sh does not provision ${u}`);
  for (const name of ['hosts', 'containers', 'logs', 'services']) {
    const text = read(`config/observe/grafana/dashboards/${name}.json`);
    const dash = JSON.parse(text);
    assert.equal(dash.uid, name);
    for (const m of text.matchAll(/"datasource":\s*\{\s*"type":\s*"(\w+)",\s*"uid":\s*"([^"]+)"/g)) {
      assert.ok(uids.has(m[2]) || m[2].startsWith('$') || ['grafana', 'datasource'].includes(m[1]), `${name}: unknown uid ${m[2]}`);
    }
  }
});

test('the Services dashboard follows the stack filter and lists every hub job that deploy-hub.sh scrapes', () => {
  const text = read('config/observe/grafana/dashboards/services.json');
  for (const m of text.matchAll(/"expr": "([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
    const expr = m[1];
    if (/stack_backup_/.test(expr)) assert.match(expr, /stack=~\\"\$stack\\"/, `backup panel ignores $stack: ${expr}`);
  }
  const jobs = /up\{job=~\\"([a-z|]+)\\"\}/.exec(text)[1].split('|').sort();
  const scraped = [...read('host/hub/deploy-hub.sh').matchAll(/job_name: ([a-z]+)/g)].map((m) => m[1]).filter((j) => j !== 'node').sort();
  assert.deepEqual(jobs, scraped);
});


test('only cloudflared always runs: every other service belongs to a component profile', () => {
  const always = services.filter((s) => s.profiles.length === 0).map((s) => s.name);
  assert.deepEqual(always, ['cloudflared']);
});

test('removing one component from the full tier removes exactly its own services', () => {
  const full = tier('full');
  const names = (profiles) => planTier(services, { profiles, vars: full.vars }).services.map((s) => s.name);
  const all = names(full.profiles);
  for (const c of full.profiles) {
    const without = names(full.profiles.filter((p) => p !== c));
    const gone = all.filter((n) => !without.includes(n));
    assert.ok(gone.includes(c), `${c} should disappear with its profile`);
    for (const g of gone) assert.ok(services.find((s) => s.name === g).profiles.includes(c), `${g} left only because ${c} was removed`);
  }
});
