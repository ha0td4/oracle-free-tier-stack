import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoutes, splitSection, templateId } from './repo.mjs';

test('parseRoutes reads the published-routes table of CLOUDFLARE.md, with the component from its Component column', () => {
  const md = '# C\n\n## 1. Tunnel\n\n### 1.2 Publish the routes\n\ntext\n\n| Subdomain | Service URL | Component |\n|---|---|---|\n'
    + '| `app` | `http://app-one:5678` | app-one |\n| `board` | `http://localhost:3000` | agent-x (`ops` network) |\n| `root` | `http://blog:80` | always |\n\n### 1.3 Next\n';
  assert.deepEqual(parseRoutes(md), [
    { sub: 'app', url: 'http://app-one:5678', component: 'app-one' },
    { sub: 'board', url: 'http://localhost:3000', component: 'agent-x' },
    { sub: 'root', url: 'http://blog:80', component: 'always' },
  ]);
});

test('parseRoutes needs the Component column', () => {
  const md = '### B6. Publish the routes\n\n| Subdomain | Service URL |\n|---|---|\n| `app` | `http://app:1` |\n';
  assert.throws(() => parseRoutes(md), /Component/);
});

test('parseRoutes reads every row of the real table, each with a known component', () => {
  const real = readReal();
  const section = real.slice(real.indexOf('### B6. Publish the routes'));
  const end = section.search(/\n#{1,3} /);
  const table = end < 0 ? section : section.slice(0, end);
  const rowCount = table.split('\n').filter((l) => /^\| `[a-z0-9-]+` \|/.test(l)).length;
  const routes = parseRoutes(real);
  assert.ok(rowCount > 0);
  assert.equal(routes.length, rowCount);
  const compose = COMPOSE.map((p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')).join('\n');
  const names = new Set([...compose.matchAll(/^ {2}([a-z0-9][a-z0-9-]*):\s*$/gm)].map((m) => m[1]));
  for (const r of routes) {
    assert.match(r.sub, /^[a-z0-9-]+$/);
    assert.match(r.url, /^https?:\/\//);
    assert.ok(r.component === 'always' || names.has(r.component), `${r.sub}: unknown component ${r.component}`);
  }
});

test('splitSection cuts a section up to the next rule or heading', () => {
  const md = 'intro\n\n## Variables\n\nabout\n\n| a |\n|---|\n| 1 |\n\n---\n\n## A. Next\n\nbody\n';
  const { section, rest } = splitSection(md, 'Variables');
  assert.match(section, /^## Variables/);
  assert.match(section, /\| 1 \|/);
  assert.doesNotMatch(section, /Next/);
  assert.match(rest, /intro/);
  assert.match(rest, /## A\. Next/);
  assert.doesNotMatch(rest, /Variables/);
});

test('templateId makes a stable anchor from a path', () => {
  assert.equal(templateId('config/dash/config.yml'), 'tpl-config-dash-config-yml');
  assert.equal(templateId('.env.example'), 'tpl-env-example');
});

import { readFileSync } from 'node:fs';
function readReal() { return readFileSync(new URL('../../CLOUDFLARE.md', import.meta.url), 'utf8'); }

import { parseTemplates } from './repo.mjs';

test('parseTemplates reads the components each template needs from its Component column', () => {
  const md = '# C\n\n## Config templates\n\n| File | Purpose | Goes to | Apply with | Component |\n|---|---|---|---|---|\n'
    + '| `.env.example` | env | `.env` | `up` | always |\n'
    + '| `config/hermes/a.yaml` | h | `data/hermes/a.yaml` | restart | hermes |\n'
    + '| `config/hermes/oidc.env.example` | o | `x` | up | hermes pocket-id |\n';
  const rows = parseTemplates(md, ['hermes', 'pocket-id', 'n8n']);
  assert.deepEqual(rows.map((r) => [r.path, r.needs]), [
    ['.env.example', []],
    ['config/hermes/a.yaml', ['hermes']],
    ['config/hermes/oidc.env.example', ['hermes', 'pocket-id']],
  ]);
});

test('every template of the real CUSTOMIZE.md names its component, and only known ones', () => {
  const real = readFileSync(new URL('../../CUSTOMIZE.md', import.meta.url), 'utf8');
  const compose = COMPOSE.map((p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')).join('\n');
  const names = [...compose.matchAll(/^ {2}([a-z0-9][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
  const rows = parseTemplates(real, names);
  assert.ok(rows.length >= 14);
  assert.deepEqual(rows.find((r) => r.path === 'config/dash/config.yml').needs, ['homer']);
  assert.deepEqual(rows.find((r) => r.path === 'config/searxng/settings.yml').needs, ['searxng']);
  assert.deepEqual(rows.find((r) => r.path === 'versions.env').needs, []);
});

import { componentRows, COMPOSE_FILES as COMPOSE } from './repo.mjs';

test('componentRows reads each component with its services, the components it needs and whether it needs 4K pages', () => {
  const md = '# C\n\n## Components\n\n| Name | Services | Needs | Notes |\n|---|---|---|---|\n'
    + '| `omniroute` | `omniroute` | | gateway |\n'
    + '| `hermes` | `hermes` | `omniroute` for models, 4K pages | agent |\n'
    + '| `alloy` | `alloy`, `socket-proxy` | | metrics and logs |\n';
  const rows = componentRows(md, ['omniroute', 'hermes', 'alloy']);
  assert.deepEqual(rows, [
    { name: 'omniroute', services: ['omniroute'], requires: [], needs4k: false, note: 'gateway' },
    { name: 'hermes', services: ['hermes'], requires: ['omniroute'], needs4k: true, note: 'agent' },
    { name: 'alloy', services: ['alloy', 'socket-proxy'], requires: [], needs4k: false, note: 'metrics and logs' },
  ]);
});

test('the real Components table lists every optional component and marks the ones that need 4K pages', () => {
  const real = readFileSync(new URL('../../CUSTOMIZE.md', import.meta.url), 'utf8');
  const compose = COMPOSE.map((p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')).join('\n');
  const profiles = [...compose.matchAll(/^ {4}profiles: \[(.*?)\]/gm)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
  const names = [...compose.matchAll(/^ {2}([a-z0-9][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
  const rows = componentRows(real, names);
  assert.deepEqual(rows.map((r) => r.name).sort(), [...new Set(profiles)].sort());
  assert.deepEqual(rows.filter((r) => r.needs4k).map((r) => r.name).sort(), ['crawl4ai', 'hermes', 'valkey']);
  assert.deepEqual(rows.find((r) => r.name === 'hermes').requires, ['omniroute']);
});
