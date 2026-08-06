import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRepo, parseRoutes, isHubService, HUB_SERVICES } from './lib/repo.mjs';
import { parseCompose } from './lib/stack.mjs';

const repo = loadRepo(new URL('../', import.meta.url));
const map = readFileSync(new URL('./guide/map.html', import.meta.url), 'utf8');
const names = (attr) => new Set([...map.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].flatMap((m) => m[1].split(' ')));

test('the map partial covers every compose service and only known ones', () => {
  const services = new Set(parseCompose(repo.compose).map((s) => s.name).filter((n) => !isHubService(n)));
  const used = names('data-component');
  for (const s of services) assert.ok(used.has(s), `map has no ${s}`);
  for (const u of used) assert.ok(services.has(u), `map names unknown component ${u}`);
});

test('the hub is drawn as always-on items: data-hub, never data-component, so no tier dims it', () => {
  assert.deepEqual([...names('data-hub')].sort(), [...HUB_SERVICES].sort());
  for (const h of HUB_SERVICES) assert.ok(!names('data-component').has(h), `${h} is a hub service, not a component`);
  assert.doesNotMatch(map, /<[^>]+data-hub="[^"]*"[^>]+data-component=|<[^>]+data-component="[^"]*"[^>]+data-hub=/);
});

test('every published route of CLOUDFLARE.md has its own row in the map route table, with its address and component', () => {
  const table = /<h3>Public via Cloudflare Tunnel<\/h3>[\s\S]*?<\/table>/.exec(map)[0];
  const rows = [...table.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)].map(([, attrs, body]) => ({ component: /data-component="([^"]+)"/.exec(attrs)?.[1] ?? 'always', body }));
  const routes = parseRoutes(repo.files['CLOUDFLARE.md']);
  assert.ok(routes.length > 0);
  for (const { sub, url, component } of routes) {
    const row = rows.find((r) => new RegExp(`<td class="u">${sub}\\.DOMAIN[/<]`).test(r.body));
    assert.ok(row, `map has no row for ${sub}.DOMAIN`);
    const host = url.replace(/^https?:\/\//, '');
    assert.ok(row.body.includes(`<td class="u">${host}</td>`), `the ${sub}.DOMAIN row does not reach ${host}`);
    assert.equal(row.component, component, `the ${sub}.DOMAIN row should need ${component}`);
  }
});

// The hub's retention defaults are the settings at the top of host/hub/deploy-hub.sh: : "${METRICS_RETENTION_DAYS:=90}".
const hubScript = readFileSync(new URL('../host/hub/deploy-hub.sh', import.meta.url), 'utf8');
const hubDefault = (name) => {
  const m = new RegExp(`^: "\\$\\{${name}:=([^}]*)\\}"`, 'm').exec(hubScript);
  assert.ok(m, `deploy-hub.sh has no default for ${name}`);
  return m[1];
};

test('the map states the retention the hub installs by default', () => {
  const item = (hub) => new RegExp(`<li data-hub="${hub}">([\\s\\S]*?)</li>`).exec(map)?.[1] ?? '';
  for (const [hub, setting] of [['prometheus', 'METRICS_RETENTION_DAYS'], ['loki', 'LOGS_RETENTION_DAYS']]) {
    const days = hubDefault(setting);
    assert.match(days, /^\d+$/, setting);
    assert.match(item(hub), new RegExp(`\\b${days} days\\b`), `the ${hub} item should say ${days} days (${setting})`);
  }
});

test('Tempo is off the map as a hub service while the hub leaves it out by default', () => {
  assert.equal(hubDefault('ENABLE_TEMPO'), '0', 'deploy-hub.sh installs Tempo again: put it back on the map (data-hub) and in HUB_SERVICES');
  const days = hubDefault('TRACES_RETENTION_DAYS');
  assert.match(map, new RegExp(`<li><b>Tempo</b> <em>optional[^<]*<code>deploy-hub\\.sh --tempo</code>[^<]*\\b${days} days\\b`), `the Tempo item should say ${days} days`);
});
