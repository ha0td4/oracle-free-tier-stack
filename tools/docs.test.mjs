import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRepo, parseVariables, parseTemplates, VARIABLES_DOC } from './lib/repo.mjs';
import { lintDocs } from './lib/lint.mjs';
import { parseCompose, parseTierEnv, planTier } from './lib/stack.mjs';

const repo = loadRepo(new URL('../', import.meta.url));
const variables = parseVariables(repo.files[VARIABLES_DOC]);
const templates = parseTemplates(repo.files['CUSTOMIZE.md']);

test('the real documents pass the lint rules', () => {
  const issues = lintDocs(Object.fromEntries(Object.keys(repo.docs).map((f) => [f, repo.files[f]])), {
    docs: repo.docs,
    variables: variables.map((v) => v.name),
    templates: Object.fromEntries(templates.map((t) => [t.path, t.id])),
    components: parseCompose(repo.compose).map((s) => s.name),
    repoFiles: repo.repoFiles,
  });
  assert.deepEqual(issues.map((i) => `${i.file}:${i.line} [${i.rule}] ${i.message}`), []);
});

test('every variable is a value or a secret', () => {
  assert.ok(variables.every((v) => ['value', 'secret'].includes(v.kind)));
});

test('every declared variable is used outside the Variables table', () => {
  const body = Object.entries(repo.files)
    .map(([f, t]) => (f === VARIABLES_DOC ? t.replace(/## Variables[\s\S]*?\n---\n/, '') : t))
    .join('\n');
  for (const { name } of variables) {
    assert.ok(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(body), `${name} is declared but never used`);
  }
});

test('every config template listed in CUSTOMIZE.md exists', () => {
  assert.ok(templates.length >= 14);
  for (const t of templates) assert.ok(repo.repoFiles.has(t.path), `${t.path} is listed but missing`);
});

test('tier totals quoted in CUSTOMIZE.md match the files', () => {
  const services = parseCompose(repo.compose);
  for (const tier of ['standard', 'full', 'lite']) {
    const { totalMiB } = planTier(services, parseTierEnv(repo.files[`tiers/${tier}.env`]));
    const text = `${totalMiB.toLocaleString('en-US')} MiB`;
    assert.ok(repo.files['CUSTOMIZE.md'].includes(text), `CUSTOMIZE.md should quote ${text} for ${tier}`);
  }
});

// ---- What each tier's reader sees must not point at things the tier does not run ----
import { createRenderer } from './lib/markdown.mjs';
import { visibleHtml, visibleText } from './lib/visibility.mjs';
import { splitSection, componentRows, isHubService } from './lib/repo.mjs';

const composeServices = parseCompose(repo.compose);
const componentNames = composeServices.map((s) => s.name);
const tierActive = (tier) => new Set(planTier(composeServices, parseTierEnv(repo.files[`tiers/${tier}.env`])).services.map((s) => s.name));

// The four presets plus one synthetic tier per optional component ("full without X"), so docs stay right for any mix
// the planner can produce. A component that another one needs (Hermes needs OmniRoute) is never removed on its own.
const fullTier = parseTierEnv(repo.files['tiers/full.env']);
const dependsOn = Object.fromEntries(
  componentRows(repo.files['CUSTOMIZE.md'], componentNames).map((c) => [c.name, c.requires]),
);
const activeFor = (profiles) => new Set(planTier(composeServices, { profiles, vars: fullTier.vars }).services.map((s) => s.name));
const TIER_CASES = [
  ...['full', 'standard', 'lite'].map((name) => [name, tierActive(name)]),
  ...fullTier.profiles
    .filter((p) => !fullTier.profiles.some((other) => other !== p && (dependsOn[other] ?? []).includes(p)))
    .map((p) => [`full without ${p}`, activeFor(fullTier.profiles.filter((x) => x !== p))]),
];
const renderDoc = (file) => {
  const md = file === VARIABLES_DOC ? splitSection(repo.files[file], 'Variables').rest : repo.files[file];
  return createRenderer({
    docs: repo.docs, variables: variables.map((v) => v.name), templates: Object.fromEntries(templates.map((t) => [t.path, t.id])), components: componentNames,
  }).render(repo.docs[file], md);
};

// Words that name a component in the guides, per component. The hub (HUB_SERVICES) always runs, on its own VM: the docs may
// name Grafana, Prometheus or Loki in any tier.
const WORDS = {
  n8n: ['n8n'], hermes: ['Hermes', 'Discord'], alloy: ['Alloy'], blackbox: ['blackbox'], crawl4ai: ['Crawl4AI'], searxng: ['SearXNG'], 'pocket-id': ['Pocket ID', 'passkey', 'OIDC'],
  homer: ['Homer'], postgres: ['Postgres'], valkey: ['Valkey'], omniroute: ['OmniRoute'], 'socket-proxy': ['socket-proxy'], 'open-webui': ['Open WebUI', 'chat.DOMAIN'],
};

// The words of WORDS a text names while the tier does not run their component: [{ component, word }].
const strayWords = (text, active) => Object.entries(WORDS)
  .filter(([component]) => !active.has(component))
  .flatMap(([component, words]) => words
    .filter((w) => new RegExp(`(?<![A-Za-z0-9-])${w}(?![A-Za-z0-9-])`, 'i').test(text))
    .map((word) => ({ component, word })));

test('every optional component and every service it runs has words to look for in the guides', () => {
  const rows = componentRows(repo.files['CUSTOMIZE.md'], componentNames).filter((r) => !isHubService(r.name));
  assert.ok(rows.length > 5);
  for (const r of rows) for (const name of [r.name, ...r.services]) assert.ok(WORDS[name]?.length, `WORDS has no entry for ${name}`);
});

// Every document is checked; <!-- catalog --> blocks (reference content that is the same for every tier) are exempt.
for (const file of Object.keys(repo.docs)) {
  const { html, headings } = renderDoc(file);
  for (const [tier, active] of TIER_CASES) {
    // File paths such as config/hermes/... are not references to a component.
    const text = visibleText(html, active, { catalog: false }).replace(/\b(?:config|data|backup|host|tiers)\/\S+/g, '');
    test(`${file} for the ${tier} tier never names a component the tier does not run`, () => {
      const hits = strayWords(text, active).map((h) => `${h.word} (${h.component})`);
      assert.deepEqual(hits, []);
    });

    test(`${file} for the ${tier} tier never refers to a step that is hidden`, () => {
      const hiddenLabels = headings
        .filter((h) => h.needs.some((n) => !active.has(n)))
        .map((h) => /^([A-G]\d)\./.exec(h.text)?.[1])
        .filter(Boolean);
      const stray = hiddenLabels.filter((label) => new RegExp(`\\b${label}\\b`).test(text));
      assert.deepEqual(stray, []);
    });
  }
}

test('the largest tier hides nothing and each smaller tier hides more', () => {
  const { html } = renderDoc('DEPLOY.md');
  const size = (tier) => visibleHtml(html, tierActive(tier)).length;
  assert.equal(size('full'), html.length);
  assert.ok(size('lite') < size('standard') && size('standard') <= size('full'));
});

// ---- Config templates that only some tiers use must also read correctly for those tiers ----
// Universal templates (Component "always": .env.example, tiers/*.env, versions.env, ...) list every component on purpose and are skipped.
const templateRows = parseTemplates(repo.files['CUSTOMIZE.md'], componentNames).filter((t) => t.needs.length > 0);

for (const [tier, active] of TIER_CASES) {
  test(`config templates shown for the ${tier} tier never name a component the tier does not run`, () => {
    const hits = [];
    for (const t of templateRows) {
      if (!t.needs.every((n) => active.has(n))) continue; // hidden for this tier
      const content = repo.read(t.path);
      if (/^ *# needs: /m.test(content)) continue; // filters its own items per tier (the Homer launcher)
      for (const h of strayWords(content, active)) hits.push(`${t.path}: ${h.word}`);
    }
    assert.deepEqual(hits, []);
  });
}

test('every variable comes with an example value to picture it', () => {
  for (const v of variables) assert.ok(v.example && v.example !== '-', `${v.name} has no example`);
});

test('example values are neutral: reserved documentation addresses, example domains, and tokens that are plainly fake', () => {
  for (const v of variables) {
    for (const ip of v.example.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
      assert.match(ip, /^(192\.0\.2|198\.51\.100|203\.0\.113)\./, `${v.name}: ${ip} is not a reserved documentation address`);
    }
    for (const mail of v.example.match(/[\w.+-]+@[\w.-]+/g) ?? []) assert.match(mail, /@example\.(com|org|net)$/, `${v.name}: ${mail}`);
    if (v.kind === 'secret') assert.match(v.example, /EXAMPLE|…|\.\.\./, `${v.name}: a secret example must be plainly fake or shortened`);
  }
});

