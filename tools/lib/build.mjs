// Builds the static site: dist/index.html (stack map), dist/<guide>/index.html (guides) and dist/<plan>/index.html (plan).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadRepo, parseVariables, parseTemplates, parseRoutes, splitSection, isHubService, HUB_STEP, STEP_DOCS, VARIABLES_DOC } from './repo.mjs';
import { parseCompose, parseTierEnv, planTier } from './stack.mjs';
import { createRenderer, STEP_LABEL } from './markdown.mjs';
import { lintDocs } from './lint.mjs';
import { buildPlanData, planMain, planToc, planScript } from './plan-page.mjs';
import { REFERENCE_USABLE_MIB, SHARE } from '../guide/planner.mjs';

// Colour group of each container in the tier table and the RAM bar: tools/guide/style.css has a --c-<group> for each.
// observe is the Compose project of the monitoring agent (docker-compose.observe.yml); the hub itself is not a container here.
export const GROUP = {
  cloudflared: 'core', n8n: 'core', homer: 'core',
  omniroute: 'ai', 'open-webui': 'ai', hermes: 'agent', searxng: 'agent', 'pocket-id': 'team', crawl4ai: 'crawl',
  alloy: 'observe', 'socket-proxy': 'observe', blackbox: 'observe',
  postgres: 'db', valkey: 'db',
};

// Where each component is set up: a step label (resolved to the heading's id) or a section anchor. The stack map links there.
// The hub's items link to HUB_STEP (tools/lib/repo.mjs).
const COMPONENT_STEP = {
  cloudflared: 'B1', homer: 'D3',
  omniroute: 'D4', n8n: 'D5', hermes: 'D6', searxng: 'D6', crawl4ai: 'D6', 'open-webui': 'D7',
  alloy: 'D8', 'socket-proxy': 'D8', blackbox: 'D9', 'pocket-id': 'F1',
  postgres: '#customize-internal-addresses', valkey: '#customize-internal-addresses',
};

// The builder writes this file into its output directory. A later build empties the directory first (no stale pages),
// but only when it holds this file or lies in the repository's dist/ (git-ignored): a mistyped --out wipes nothing else.
export const OUT_MARKER = '.stack-guide-build';

const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export function clearOutDir(outDir, root) {
  const out = resolve(outDir);
  if (inside(out, root)) throw new Error(`Refusing to build into ${out}: it holds the repository`);
  if (!existsSync(out)) return;
  if (!statSync(out).isDirectory()) throw new Error(`Output ${out} is not a directory`);
  const entries = readdirSync(out);
  if (!entries.length) return;
  if (!entries.includes(OUT_MARKER) && !inside(join(root, 'dist'), out)) {
    throw new Error(`Refusing to empty ${out}: the builder did not write it (no ${OUT_MARKER}). Empty it yourself or pick another --out.`);
  }
  for (const name of entries) rmSync(join(out, name), { recursive: true, force: true });
}

// Sidebar groups of the guides, in reading order: panel ids per group.
const TOC_GROUPS = [
  ['Before you start', ['variables']],
  ['Set up, in order: A → G', ['prepare', 'cloudflare', 'deploy', 'identity', 'team']],
  ['For team members', ['members']],
  ['Reference', ['operations', 'customize', 'templates', 'about']],
];

const here = new URL('../guide/', import.meta.url);
const asset = (name) => readFileSync(new URL(name, here), 'utf8');
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stripParagraph = (html) => html.trim().replace(/^<p>/, '').replace(/<\/p>$/, '');

// routeComponents: the Component of each published route ("always" or a component), for the routes fact of the map.
function buildStackData(repo) {
  const services = parseCompose(repo.compose);
  const tiers = {};
  for (const name of repo.tiers) {
    const tier = parseTierEnv(repo.files[`tiers/${name}.env`]);
    const plan = planTier(services, tier);
    tiers[name] = {
      profiles: tier.profiles,
      totalMiB: plan.totalMiB,
      services: plan.services.map((s) => {
        if (!GROUP[s.name]) throw new Error(`Service ${s.name} has no group in GROUP (tools/lib/build.mjs)`);
        return { name: s.name, group: GROUP[s.name], memMiB: s.memMiB, cpus: s.cpus };
      }),
    };
  }
  return { usableMiB: REFERENCE_USABLE_MIB, budget: SHARE, tiers, routeComponents: parseRoutes(repo.files['CLOUDFLARE.md']).map((r) => r.component) };
}

const routeCount = (data, active) => data.routeComponents.filter((c) => c === 'always' || active.has(c)).length;

function tierSwitch(data) {
  const buttons = Object.keys(data.tiers)
    .map((t) => `<button type="button" data-tier="${t}" aria-pressed="${t === 'standard'}">${t}</button>`)
    .join('');
  return `<div class="tier-switch" role="group" aria-label="Resource tier"><span>Tier</span>${buttons}</div>`;
}

// switcher: the tier buttons only make sense on pages that show tier-dependent content.
// Always visible: it sits in the sticky header of the guides. app.js fills it from the ticked deploy steps.
const PROGRESS_BAR = `
  <div class="topprog" data-progress-top><span>Setup progress (A → G)</span><div class="prog" role="progressbar" aria-label="Setup progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div><b data-progress-percent>0%</b><span class="count" data-progress-count>0 / 0</span></div>
`;

function shell({ title, current, mapHref, guidesHref, planHref, toc, main, data, dataId = 'stack-data', css, js, fragment = false, switcher = true, progress = false }) {
  const link = (href, label, key) => `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`;
  // A fragment has no doctype, html, head or body: the artifact host wraps it in its own skeleton.
  const open = fragment
    ? `<title>${title}</title>
<style>
${css}
</style>
`
    : `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${css}
</style>
</head>
<body>
`;
  return `${open}<div class="site-head"><div class="in">
  <span class="brand">Oracle Stack</span>
  <nav class="routes" aria-label="Pages">${link(mapHref, 'Stack map', 'map')}${link(guidesHref, 'Guides', 'guides')}${link(planHref, 'Plan', 'plan')}</nav>
  ${switcher ? tierSwitch(data) : ''}
</div>${progress ? PROGRESS_BAR : ''}</div>
<div class="wrap">
  <nav class="toc" aria-label="Contents">
${toc}
  </nav>
  <main>
${main}
  </main>
</div>
<script type="application/json" id="${dataId}">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>
${js}
</script>
${fragment ? '' : '</body>\n</html>\n'}`;
}

function mapMain(data, partial) {
  const std = data.tiers.standard;
  const routes = routeCount(data, new Set(std.services.map((s) => s.name)));
  return `    <header class="top">
      <div class="eyebrow">Oracle A1 VM · 2 OCPU · 12 GB · ARM64</div>
      <h1>Oracle Stack Map</h1>
      <p class="lede">Where each component lives and how they connect. Pick a tier in the header to grey out what it does not run; the monitoring hub has its own VM and always runs. Click a component to open the step of the <a href="GUIDE_HREF">guides</a> that sets it up.</p>
      <div class="facts">
        <div class="fact good"><b>0</b><span>ports open to the Internet</span></div>
        <div class="fact"><b data-fact="routes">${routes}</b><span>subdomains via Cloudflare</span></div>
        <div class="fact"><b data-fact="services">${std.services.length}</b><span>containers in the <span data-tier-name>standard</span> tier</span></div>
        <div class="fact"><b data-fact="ram">${(std.totalMiB / 1024).toFixed(1)}</b><span>GB RAM, sum of container limits</span></div>
        <div class="fact"><b>1-15</b><span>people: you alone, or a team later (G)</span></div>
        <div class="fact"><b>03:30</b><span>encrypted backup every day</span></div>
      </div>
    </header>
${partial}`;
}

// artifact: the main page becomes a fragment and the download buttons go (the artifact viewer blocks downloads).
export function build({ rootUrl, outDir, guidePath = 'guide', planPath = 'plan', artifact = false }) {
  const repo = loadRepo(rootUrl);
  const variables = parseVariables(repo.files[VARIABLES_DOC]);
  const components = parseCompose(repo.compose).map((s) => s.name);
  const templates = parseTemplates(repo.files['CUSTOMIZE.md'], components);
  const templateMap = Object.fromEntries(templates.map((t) => [t.path, t.id]));

  const docFiles = Object.fromEntries(Object.keys(repo.docs).map((f) => [f, repo.files[f]]));
  const issues = lintDocs(docFiles, { docs: repo.docs, variables: variables.map((v) => v.name), templates: templateMap, components, repoFiles: repo.repoFiles });
  if (issues.length) throw new Error(`Docs lint failed:\n${issues.map((i) => `  ${i.file}:${i.line} [${i.rule}] ${i.message}`).join('\n')}`);

  const data = buildStackData(repo);
  const renderer = createRenderer({ docs: repo.docs, variables: variables.map((v) => v.name), templates: templateMap, components, stepDocs: STEP_DOCS });
  const css = asset('style.css');
  const js = asset('app.js');

  // ---- Guides ----
  const { section: variablesMd, rest: prepareMd } = splitSection(repo.files[VARIABLES_DOC], 'Variables');
  const panels = [];
  // A document whose first heading sits inside a needs block is only meant for tiers that run those components.
  const addPanel = (id, title, html, headings) => panels.push({ id: `doc-${id}`, title, html, headings, needs: headings.find((h) => h.depth === 1)?.needs ?? [] });

  const variablesDoc = renderer.render(repo.docs[VARIABLES_DOC], variablesMd);
  addPanel('variables', 'Variables', variablesDoc.html, []);

  const progress = '<div class="progress"><span>Steps done</span><div class="prog"><i></i></div><b data-progress-count>0 / 0</b><button type="button" data-progress-reset>Reset</button></div>';
  const TITLES = { prepare: 'A · Prepare', cloudflare: 'B · Cloudflare', deploy: 'C–E · Deploy', identity: 'F · Identity', team: 'G · Team (optional)', members: 'For members', operations: 'Operations', customize: 'Customize' };
  for (const [file, id] of Object.entries(repo.docs)) {
    if (id === 'about') continue;
    const doc = renderer.render(id, file === VARIABLES_DOC ? prepareMd : repo.files[file]);
    // The first step guide carries the progress bar with its Reset button.
    const html = id === STEP_DOCS[0] ? doc.html.replace('</h1>\n', `</h1>\n${progress}\n`) : doc.html;
    addPanel(id, TITLES[id], html, doc.headings);
  }

  const cards = templates.map((t) => {
    const cell = (md) => stripParagraph(renderer.render('customize', md).html);
    const name = t.path.split('/').pop();
    return `<article class="tpl" id="${t.id}"${t.needs.length ? ` data-needs="${t.needs.join(' ')}"` : ''}>
<header><h3>${escText(t.path)}</h3><div class="actions"><button type="button" class="copy">Copy</button>${artifact ? '' : `<button type="button" class="copy download" data-filename="${escText(name)}">Download</button>`}</div></header>
<dl><dt>Purpose</dt><dd>${cell(t.purpose)}</dd><dt>Goes to</dt><dd>${cell(t.goesTo)}</dd><dt>Apply with</dt><dd>${cell(t.apply)}</dd></dl>
<pre><code>${escText(repo.read(t.path))}</code></pre>
</article>`;
  }).join('\n');
  addPanel('templates', 'Config templates', `<h1 id="templates">Config templates</h1>\n<p>The real files of this repository, ready to copy or download. Where each one goes and how to apply it is listed on every card; the same table is in <a href="#customize-config-templates">Customize</a>.</p>\n${cards}`,
    templates.map((t) => ({ depth: 2, text: t.path, id: t.id, needs: t.needs })));

  const about = renderer.render('about', repo.files['README.md']);
  addPanel('about', 'About', about.html, about.headings);

  const tocItem = (p) => {
    const subs = p.headings.filter((h) => h.depth === 2 || (STEP_DOCS.includes(p.id.slice(4)) && h.depth === 3 && STEP_LABEL.test(h.text)));
    const list = subs.length ? `<ul>${subs.map((h) => `<li${h.needs?.length ? ` data-needs="${h.needs.join(' ')}"` : ''}><a href="#${h.id}">${escText(h.text)}</a></li>`).join('')}</ul>` : '';
    const needs = p.needs.length ? ` data-needs="${p.needs.join(' ')}"` : '';
    return `      <li data-doc="${p.id}"${needs}><a href="#${p.id}">${p.title}</a>${list}</li>`;
  };
  const grouped = new Set(TOC_GROUPS.flatMap(([, ids]) => ids.map((id) => `doc-${id}`)));
  const ungrouped = panels.filter((p) => !grouped.has(p.id));
  if (ungrouped.length) throw new Error(`Panels without a sidebar group: ${ungrouped.map((p) => p.id).join(', ')}`);
  const toc = TOC_GROUPS.map(([label, ids]) => {
    const members = ids.map((id) => panels.find((p) => p.id === `doc-${id}`)).filter(Boolean);
    // A group of one tier-dependent document hides with it.
    const needs = members.length === 1 && members[0].needs.length ? ` data-needs="${members[0].needs.join(' ')}"` : '';
    return `      <li class="toc-group"${needs}><span>${escText(label)}</span></li>\n${members.map(tocItem).join('\n')}`;
  }).join('\n');

  // The stack map links each component to the step that sets it up.
  const headingIds = new Map(panels.flatMap((p) => p.headings).filter((h) => STEP_LABEL.test(h.text)).map((h) => [h.text.split('.')[0], h.id]));
  const allIds = new Set(panels.flatMap((p) => [p.id, ...p.headings.map((h) => h.id)]));
  const stepLink = (target, what) => {
    const id = target.startsWith('#') ? target.slice(1) : headingIds.get(target);
    if (!id || !allIds.has(id)) throw new Error(`Setup step ${target} of ${what} is not a heading of the guides`);
    return { href: `${guidePath}/index.html#${id}`, label: target.startsWith('#') ? '' : target };
  };
  data.stepLinks = Object.fromEntries(components.filter((c) => !isHubService(c)).map((c) => {
    if (!COMPONENT_STEP[c]) throw new Error(`Component ${c} has no setup step in COMPONENT_STEP (tools/lib/build.mjs)`);
    return [c, stepLink(COMPONENT_STEP[c], c)];
  }));
  data.hubLink = stepLink(HUB_STEP, 'the monitoring hub');

  const guidesMain = `    <header class="top compact">
      <div class="eyebrow">Guides · built from the Markdown docs</div>
      <p class="lede">Collect the variables, then follow the step guides from A to F: Prepare, Cloudflare, Deploy, Identity. G (Team) is only for when other people join. In Deploy each service gets one step (log in, connect it to the services before it, check); Identity then adds a Pocket ID login next to each app's own, which stays as the fallback. Placeholders in <span class="var">UPPERCASE</span> are yours to replace.
      Pick your tier in the header: steps, rows and files for components it does not run are hidden.</p>
    </header>
${panels.map((p) => `    <section class="doc" id="${p.id}">\n${p.html}\n    </section>`).join('\n')}`;

  const planData = buildPlanData(repo);

  // ---- Map ----
  const mapPartial = asset('map.html');

  const files = {
    [join(outDir, 'index.html')]: shell({
      title: 'Oracle Stack Map', current: 'map', mapHref: 'index.html', guidesHref: `${guidePath}/index.html`, planHref: `${planPath}/index.html`, data, css, js, fragment: artifact,
      toc: `    <div class="brand">Stack map</div>\n    <ol>\n      <li><a href="#layers">Stack layers</a></li>\n      <li><a href="#diagram">System diagram</a></li>\n      <li><a href="#routes">Route map</a></li>\n    </ol>`,
      main: mapMain(data, mapPartial).replace('GUIDE_HREF', `${guidePath}/index.html`),
    }),
    [join(outDir, guidePath, 'index.html')]: shell({
      title: 'Oracle Stack Guides', current: 'guides', mapHref: '../index.html', guidesHref: 'index.html', planHref: `../${planPath}/index.html`, data, css, js, progress: true,
      toc: `    <div class="brand">Guides</div>\n    <ol>\n${toc}\n    </ol>`,
      main: guidesMain,
    }),
    [join(outDir, planPath, 'index.html')]: shell({
      title: 'Oracle Stack Plan', current: 'plan', mapHref: '../index.html', guidesHref: `../${guidePath}/index.html`, planHref: 'index.html', data: planData, dataId: 'plan-data', css, js: planScript(), switcher: false,
      toc: planToc,
      main: planMain(planData),
    }),
  };
  // Everything is rendered before the output is touched: a failing build leaves the last good site in place.
  clearOutDir(outDir, repo.root);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, OUT_MARKER), 'Written by tools/build-guide.mjs. The next build empties this directory first.\n');
  for (const [path, html] of Object.entries(files)) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, html);
  }
  return { files: Object.keys(files), panels: panels.map((p) => p.id) };
}
