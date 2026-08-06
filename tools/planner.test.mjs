import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRepo, componentRows } from './lib/repo.mjs';
import { parseCompose, parseTierEnv, planTier, parseMem } from './lib/stack.mjs';
import { usableMiB, hostOverheadMiB, budget, fitPresets, recommend, buildTier, buildPresetStart, HEAP, HOST_PROFILES, toMemString, REFERENCE_USABLE_MIB } from './guide/planner.mjs';

const repo = loadRepo(new URL('../', import.meta.url));
const services = parseCompose(repo.compose);
const names = services.map((s) => s.name);
const components = componentRows(repo.files['CUSTOMIZE.md'], names);
const presets = repo.tiers.map((name) => {
  const t = parseTierEnv(repo.files[`tiers/${name}.env`]);
  const plan = planTier(services, t);
  return { name, profiles: t.profiles, totalMiB: plan.totalMiB, needs4k: components.filter((c) => c.needs4k && t.profiles.includes(c.name)).map((c) => c.name) };
});
const host = (gb, { profile = 'full', pageSize4k = true } = {}) => {
  const usable = usableMiB(gb);
  return { usableMiB: usable, hostOverheadMiB: hostOverheadMiB(usable, profile), pageSize4k };
};
const byName = (fit) => Object.fromEntries(fit.map((f) => [f.name, f.status]));

test('usable RAM follows the measured 12 GB shape', () => {
  assert.equal(usableMiB(12), REFERENCE_USABLE_MIB);
  assert.equal(usableMiB(1), 994);
});

test('the host overhead is a fixed part per setup plus a share of RAM, and a leaner setup needs less', () => {
  const usable = usableMiB(12);
  assert.ok(Math.abs(hostOverheadMiB(usable, 'full') - 1000) <= 10, 'about 1,000 MiB on the 12 GB shape, as measured');
  assert.ok(hostOverheadMiB(usable, 'nocrowdsec') < hostOverheadMiB(usable, 'full'));
  assert.ok(hostOverheadMiB(usable, 'lean') < hostOverheadMiB(usable, 'nocrowdsec'));
  assert.ok(hostOverheadMiB(usableMiB(1), 'full') < hostOverheadMiB(usable, 'full'), 'smaller machines have fewer page tables');
  for (const p of Object.values(HOST_PROFILES)) assert.ok(p.label.length > 10 && p.fixedMiB > 0);
});

test('the budget is the smaller of the 85% rule and what the host leaves', () => {
  assert.deepEqual(budget({ usableMiB: 11922, hostOverheadMiB: 1000 }), { ruleMiB: 10133, hardMiB: 10922, availableMiB: 10133 });
  assert.deepEqual(budget({ usableMiB: 1986, hostOverheadMiB: 1000 }), { ruleMiB: 1688, hardMiB: 986, availableMiB: 986 });
  assert.equal(budget({ usableMiB: 900, hostOverheadMiB: 1000 }).availableMiB, 0);
});

test('on the 12 GB shape standard fits, full is tight (over the 85% rule, under the hard ceiling), and the recommendation is standard', () => {
  const fit = fitPresets(presets, host(12));
  assert.deepEqual(byName(fit), { full: 'tight', standard: 'fits', lite: 'fits' });
  assert.equal(recommend(fit), 'standard');
});

test('on a 6 GB host lite is the largest tier that fits', () => {
  const fit = fitPresets(presets, host(6));
  assert.equal(byName(fit).standard, 'no');
  assert.equal(recommend(fit), 'lite');
});

test('a 1 GB host fits no ready-made tier, whatever the host setup: it needs a tier built on the page', () => {
  for (const profile of ['full', 'nocrowdsec', 'lean']) assert.equal(recommend(fitPresets(presets, host(1, { profile }))), null, profile);
});

test('64K pages rule out every tier that runs a component needing 4K pages, with the reason', () => {
  const fit = fitPresets(presets, host(12, { pageSize4k: false }));
  assert.deepEqual(byName(fit), { full: 'no', standard: 'no', lite: 'no' });
  const standard = fit.find((f) => f.name === 'standard');
  assert.ok(standard.notes.some((n) => /4K pages/.test(n) && /hermes/.test(n) && /crawl4ai/.test(n)));
});

test('a preset that does not fit says how far over the budget it is', () => {
  const fit = fitPresets(presets, host(6));
  assert.ok(fit.find((f) => f.name === 'standard').notes.some((n) => /over/.test(n) && /MiB/.test(n)));
});

test('buildTier turns a selection into a tier file whose total matches the compose limits', () => {
  const t = buildTier({ services, components, selected: ['n8n', 'omniroute', 'hermes'], name: 'mine' });
  assert.deepEqual(t.profiles, ['n8n', 'omniroute', 'hermes']);
  assert.equal(t.totalMiB, planTier(services, { profiles: t.profiles, vars: {} }).totalMiB);
  assert.match(t.env, /^COMPOSE_PROFILES=n8n,omniroute,hermes$/m);
  // The limits are the compose defaults, written in the compose notation.
  for (const name of ['n8n', 'cloudflared']) {
    const s = services.find((x) => x.name === name);
    assert.match(t.env, new RegExp(`^${s.memVar}=${toMemString(s.memDefault)}$`, 'm'), name);
  }
  assert.doesNotMatch(t.env, /MEM_POSTGRES/);
  assert.match(t.env, /tiers\/mine\.env/);
});

test('buildTier adds the components a selection needs and says so', () => {
  const t = buildTier({ services, components, selected: ['hermes'] });
  assert.deepEqual(t.profiles, ['omniroute', 'hermes']);
  assert.deepEqual(t.added, ['omniroute']);
});

test('buildTier counts a service that two selected components share once', () => {
  // No service of this repo is in two profiles today; compose allows it (profiles: [a, b]), so the planner must handle it.
  const svc = (name, profiles, mem) => ({ name, profiles, memVar: `MEM_${name.toUpperCase()}`, memDefault: mem, cpusVar: null, cpusDefault: null });
  const fake = [svc('gate', [], 100), svc('alpha', ['alpha'], 200), svc('beta', ['beta'], 300), svc('shared', ['alpha', 'beta'], 50)];
  const parts = [{ name: 'alpha', requires: [], needs4k: false }, { name: 'beta', requires: [], needs4k: false }];
  const both = buildTier({ services: fake, components: parts, selected: ['alpha', 'beta'] });
  const one = buildTier({ services: fake, components: parts, selected: ['alpha'] });
  const shared = (t) => t.services.filter((s) => s.name === 'shared').length;
  assert.equal(shared(both), 1);
  assert.equal(shared(one), 1);
  assert.equal(both.totalMiB, 100 + 200 + 300 + 50);
  assert.equal((both.env.match(/^MEM_SHARED=/gm) ?? []).length, 1);
});

test('buildTier keeps the order of the compose file, whatever the order of the selection', () => {
  assert.deepEqual(buildTier({ services, components, selected: ['hermes', 'n8n'] }).profiles, ['n8n', 'omniroute', 'hermes']);
});

test('overridden limits are written to the tier file, and the heap follows the limit', () => {
  const t = buildTier({ services, components, selected: ['n8n'], memOverrides: { n8n: 384, cloudflared: 96 } });
  assert.match(t.env, /^MEM_N8N=384m$/m);
  assert.match(t.env, /^N8N_HEAP_MB=288$/m);
  assert.match(t.env, /^MEM_CLOUDFLARED=96m$/m);
  assert.equal(t.totalMiB, 480);
});

test('the heap ratios match the defaults in docker-compose.yml', () => {
  const compose = repo.files['docker-compose.yml'];
  for (const [component, { env, ratio }] of Object.entries(HEAP)) {
    const heap = Number(new RegExp(`\\$\\{${env}:-(\\d+)\\}`).exec(compose)[1]);
    const mem = services.find((s) => s.name === component).memDefault;
    assert.ok(Math.abs(heap - Math.round(mem * ratio)) <= 1, `${component}: ${heap} vs ${mem * ratio}`);
  }
});

test('buildTier warns when 4K pages are missing for a selected component', () => {
  const t = buildTier({ services, components, selected: ['crawl4ai'], pageSize4k: false });
  assert.ok(t.warnings.some((w) => /crawl4ai/.test(w) && /4K pages/.test(w)));
});

test('toMemString writes whole gigabytes as g and everything else as m', () => {
  assert.equal(toMemString(1024), '1g');
  assert.equal(toMemString(3072), '3g');
  assert.equal(toMemString(1536), '1536m');
  assert.equal(toMemString(96), '96m');
  assert.equal(parseMem(toMemString(1536)), 1536);
});

test('a preset used as a starting point reproduces its tier file: the same services with the same memory and CPU limits', () => {
  for (const name of repo.tiers) {
    const tier = parseTierEnv(repo.files[`tiers/${name}.env`]);
    const start = buildPresetStart(services, tier);
    const t = buildTier({ services, components, selected: tier.profiles, memOverrides: start.mem, cpuOverrides: start.cpus, name });
    assert.deepEqual(planTier(services, parseTierEnv(t.env)), planTier(services, tier), name);
  }
});
