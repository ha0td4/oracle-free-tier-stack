// Reads the repository (docs, compose, tiers) and the two tables in the docs that drive the guide.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { componentsIn } from './markdown.mjs';

// Document file -> id used in anchors, in navigation order: the step guides A → G first, then the references.
export const DOCS = {
  'PREPARE.md': 'prepare',
  'CLOUDFLARE.md': 'cloudflare',
  'DEPLOY.md': 'deploy',
  'IDENTITY.md': 'identity',
  'TEAM.md': 'team',
  'MEMBERS.md': 'members',
  'OPERATIONS.md': 'operations',
  'CUSTOMIZE.md': 'customize',
  'README.md': 'about',
};

// Documents whose ### headings are steps (A1, B2...): they get a done checkbox and are listed in the contents.
export const STEP_DOCS = ['prepare', 'cloudflare', 'deploy', 'identity', 'team'];

// The compose files whose services make up the stack: the apps and the observe project (monitoring, a separate Compose project).
export const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.observe.yml'];

// The document that holds the Variables table.
export const VARIABLES_DOC = 'PREPARE.md';

// The monitoring hub: its own small VM, installed by host/hub/deploy-hub.sh as systemd services, not Compose containers.
// The stack map shows it as an always-on, external part of the stack that the tier switcher never dims. A Compose service with
// one of these names is not a component of the map or the planner.
// Tempo is optional (deploy-hub.sh --tempo, off by default): not on the map as a hub service
export const HUB_SERVICES = ['prometheus', 'loki', 'grafana', 'node_exporter'];
export const isHubService = (name) => HUB_SERVICES.includes(name);
// The guide step that sets the hub up: the map links its items there.
export const HUB_STEP = 'D8';

// .claude holds editor settings and, in the main checkout, whole copies of the repository (agent worktrees).
const SKIP_DIRS = new Set(['node_modules', 'dist', 'data', '.git', '.claude']);
// Largest to smallest; `standard` is still the default tier.
const TIERS = ['full', 'standard', 'lite'];

export const templateId = (path) => `tpl-${path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

function walk(root, dir = '') {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(root, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

export function loadRepo(rootUrl) {
  const root = fileURLToPath(rootUrl);
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const files = {};
  for (const f of Object.keys(DOCS)) files[f] = read(f);
  for (const f of COMPOSE_FILES) files[f] = read(f);
  for (const t of TIERS) files[`tiers/${t}.env`] = read(`tiers/${t}.env`);
  // Both compose files as one text: parseCompose reads every services: section in it.
  const compose = COMPOSE_FILES.map((f) => files[f]).join('\n');
  return { root, files, compose, docs: DOCS, tiers: TIERS, repoFiles: new Set(walk(root)), read };
}

// Rows of the first table that follows a heading ("## title" by default; a RegExp matches the heading text instead).
function tableWithHeader(markdown, title, level = '##') {
  const lines = markdown.split(/\r?\n/);
  const isTitle = typeof title === 'string'
    ? (l) => l.trim() === `${level} ${title}`
    : (l) => l.startsWith(`${level} `) && title.test(l.trim().slice(level.length + 1));
  const start = lines.findIndex(isTitle);
  if (start < 0) throw new Error(`Section "${title}" not found`);
  const rows = [];
  let seen = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break;
    if (line.trim().startsWith('|')) {
      seen = true;
      if (/^\|[\s:|-]+\|?$/.test(line.trim())) continue;
      rows.push(line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim()));
    } else if (seen) {
      break;
    }
  }
  return { header: rows[0] ?? [], rows: rows.slice(1) };
}

const tableUnder = (markdown, title, level) => tableWithHeader(markdown, title, level).rows;

const unTick = (s) => s.replace(/`/g, '');

export function parseVariables(deployMarkdown) {
  const { header, rows } = tableWithHeader(deployMarkdown, 'Variables');
  const col = (name) => header.findIndex((h) => h.toLowerCase() === name);
  const [iNames, iMeaning, iSource, iExample, iKind] = ['name', 'what it is', 'where to get it', 'example', 'kind'].map(col);
  return rows.flatMap((cells) =>
    [...cells[iNames].matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => ({
      name: m[1], meaning: cells[iMeaning], source: cells[iSource], example: unTick(cells[iExample]), kind: unTick(cells[iKind]),
    })));
}

// `components` is the list of known component names; the Component column of each row says which ones the template needs.
export function parseTemplates(customizeMarkdown, components = []) {
  const { header, rows } = tableWithHeader(customizeMarkdown, 'Config templates');
  const col = header.findIndex((h) => h.toLowerCase() === 'component');
  return rows.map((cells) => {
    const [file, purpose, goesTo, apply] = cells;
    const path = unTick(file);
    return { path, id: templateId(path), purpose, goesTo, apply, needs: col >= 0 ? componentsIn(cells[col], components) : [] };
  });
}

// Subdomain routes published in CLOUDFLARE.md (the "Publish the routes" step). component is the first word of the Component
// column: "always" or the component the route needs. The URL host says nothing (the hub's Grafana is http://localhost:3000).
export function parseRoutes(cloudflareMarkdown) {
  const { header, rows } = tableWithHeader(cloudflareMarkdown, /Publish the routes$/, '###');
  const [iSub, iUrl, iComponent] = ['subdomain', 'service url', 'component'].map((name) => header.findIndex((h) => h.toLowerCase() === name));
  if (Math.min(iSub, iUrl, iComponent) < 0) throw new Error('The Publish the routes table needs the columns Subdomain, Service URL and Component');
  return rows.map((cells) => ({
    sub: unTick(cells[iSub]),
    url: unTick(cells[iUrl]),
    component: (/[a-z][a-z0-9-]*/.exec(unTick(cells[iComponent])) ?? [''])[0],
  }));
}

// Cuts "## title", up to the next horizontal rule or "## " heading, out of a document.
export function splitSection(markdown, title) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${title}`);
  if (start < 0) throw new Error(`Section "${title}" not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---' || lines[i].startsWith('## ')) { end = i; break; }
  }
  return { section: lines.slice(start, end).join('\n'), rest: [...lines.slice(0, start), ...lines.slice(end)].join('\n') };
}

// The Components table of CUSTOMIZE.md: one row per optional component, with its services, the components it needs and whether it needs 4K pages.
export function componentRows(customizeMarkdown, components = []) {
  return tableUnder(customizeMarkdown, 'Components').map(([name, services, needs, note]) => ({
    name: unTick(name),
    services: [...services.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]),
    requires: componentsIn(needs, components).filter((c) => c !== unTick(name)),
    needs4k: /4K pages/.test(needs),
    note,
  }));
}
