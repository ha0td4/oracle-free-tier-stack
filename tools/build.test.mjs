import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, clearOutDir, GROUP, OUT_MARKER } from './lib/build.mjs';
import { loadRepo, isHubService, HUB_SERVICES } from './lib/repo.mjs';
import { parseCompose, parseTierEnv, planTier } from './lib/stack.mjs';
import { REFERENCE_USABLE_MIB, SHARE } from './guide/planner.mjs';

const rootUrl = new URL('../', import.meta.url);
const repo = loadRepo(rootUrl);
const composeServices = parseCompose(repo.compose);
// Components of the map: every compose service except the hub's (it is not a Compose project any more).
const services = composeServices.map((s) => s.name).filter((n) => !isHubService(n));
const tierPlan = (name) => planTier(composeServices, parseTierEnv(repo.files[`tiers/${name}.env`]));

// Every output directory of this file, removed when the tests end.
const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'guide-'));
  dirs.push(dir);
  return dir;
};
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

let out;
let map;
let guides;

before(() => {
  out = tmp();
  build({ rootUrl, outDir: out });
  map = readFileSync(join(out, 'index.html'), 'utf8');
  guides = readFileSync(join(out, 'guide', 'index.html'), 'utf8');
});

const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const localLinks = (html) => [...html.matchAll(/\shref="#([^"]+)"/g)].map((m) => m[1]);
const stackData = (html) => JSON.parse(/<script type="application\/json" id="stack-data">([\s\S]*?)<\/script>/.exec(html)[1]);

test('in-page links resolve on both pages', () => {
  for (const [name, html] of [['map', map], ['guides', guides]]) {
    const known = ids(html);
    const broken = [...new Set(localLinks(html))].filter((id) => !known.has(id));
    assert.deepEqual(broken, [], `${name} has links to missing ids`);
  }
});

test('embedded data: standard stays inside the budget of the reference VM', () => {
  const data = stackData(guides);
  assert.equal(data.usableMiB, REFERENCE_USABLE_MIB);
  assert.equal(data.budget, SHARE);
  assert.ok(data.tiers.standard.totalMiB <= data.usableMiB * data.budget, 'the default tier must fit the reference VM');
  assert.ok(data.tiers.full.services.every((s) => s.group));
});

test('every compose service that a tier can run has a group, and the hub has none', () => {
  for (const s of services) assert.ok(GROUP[s], `${s} has no group`);
  for (const h of HUB_SERVICES) assert.equal(GROUP[h], undefined, h);
});

test('a build replaces what an earlier build wrote: no stale page survives', () => {
  const dir = tmp();
  build({ rootUrl, outDir: dir });
  mkdirSync(join(dir, 'old-page'));
  writeFileSync(join(dir, 'old-page', 'index.html'), 'stale');
  build({ rootUrl, outDir: dir });
  assert.ok(!existsSync(join(dir, 'old-page')), 'the stale page is still there');
  assert.ok(existsSync(join(dir, OUT_MARKER)));
  assert.ok(existsSync(join(dir, 'index.html')));
});

test('the builder never empties a directory it did not write, nor the repository', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'keep.txt'), 'mine');
  assert.throws(() => build({ rootUrl, outDir: dir }), /Refusing to empty/);
  assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'mine');
  assert.throws(() => clearOutDir(repo.root, repo.root), /holds the repository/);
  assert.throws(() => clearOutDir(join(repo.root, '..'), repo.root), /holds the repository/);
  assert.throws(() => clearOutDir(join(repo.root, 'tools'), repo.root), /Refusing to empty/);
  assert.ok(readdirSync(join(repo.root, 'tools')).length > 0);
});

// ---- The Plan route: size a machine and build a tier file ----
let plan;
before(() => { plan = readFileSync(join(out, 'plan', 'index.html'), 'utf8'); });

test('the plan page embeds the sizing data generated from the repository files', () => {
  const data = JSON.parse(/<script type="application\/json" id="plan-data">([\s\S]*?)<\/script>/.exec(plan)[1]);
  assert.deepEqual(data.presets.map((p) => p.name), ['full', 'standard', 'lite']);
  for (const p of data.presets) assert.equal(p.totalMiB, tierPlan(p.name).totalMiB, p.name);
  assert.deepEqual(data.presets.find((p) => p.name === 'full').needs4k.sort(), ['crawl4ai', 'hermes', 'valkey']);
  const hermes = data.components.find((c) => c.name === 'hermes');
  assert.deepEqual(hermes.requires, ['omniroute']);
  assert.equal(hermes.needs4k, true);
  assert.ok(data.components.every((c) => c.memMiB > 0 && c.services.length > 0));
  assert.ok(data.services.some((s) => s.name === 'cloudflared' && s.memVar === 'MEM_CLOUDFLARED'));
  assert.ok(!data.components.some((c) => isHubService(c.name)), 'the hub runs on its own VM: nothing to size here');
  assert.deepEqual(Object.keys(data.hostProfiles), ['full', 'nocrowdsec', 'lean']);
});

test('every compose service and the hub link from the stack map to the guide step that sets them up', () => {
  const data = stackData(map);
  const links = [...services.map((s) => [s, data.stepLinks[s]]), ['the hub', data.hubLink]];
  for (const [what, link] of links) {
    assert.ok(link, `no setup link for ${what}`);
    const id = link.href.split('#')[1];
    assert.ok(guides.includes(` id="${id}"`), `${what} links to #${id}, which the guides do not have`);
  }
  for (const h of HUB_SERVICES) assert.equal(data.stepLinks[h], undefined, `${h} is part of the hub, not a component`);
});

test('the routes fact counts the published routes the default tier runs, by their Component column', () => {
  const data = stackData(map);
  const active = new Set(data.tiers.standard.services.map((s) => s.name));
  const expected = data.routeComponents.filter((c) => c === 'always' || active.has(c)).length;
  assert.ok(expected > 0);
  assert.match(map, new RegExp(`<b data-fact="routes">${expected}</b>`));
});

