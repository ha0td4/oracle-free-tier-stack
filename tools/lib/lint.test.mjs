import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintDocs } from './lint.mjs';

const docs = { 'DEPLOY.md': 'deploy', 'CLOUDFLARE.md': 'cloudflare' };
const base = { docs, variables: ['DOMAIN'], templates: {}, components: ['n8n', 'hermes', 'homer'], repoFiles: new Set(['stack.sh', 'config/dash/config.yml']) };
const lint = (files) => lintDocs(files, base);
const rules = (files) => lint(files).map((i) => i.rule);

test('clean documents produce no issues', () => {
  assert.deepEqual(lint({ 'DEPLOY.md': '# T\n\n## A. Accounts\n\n[x](CLOUDFLARE.md#1-tunnel)\n', 'CLOUDFLARE.md': '# C\n\n## 1. Tunnel\n' }), []);
});

test('a bold context label must be one the renderer turns into a chip', () => {
  assert.deepEqual(rules({ 'DEPLOY.md': '**[Host]** then **[Remote_VM]** then **[Hub_VM]**\n' }), []);
  assert.deepEqual(rules({ 'DEPLOY.md': '**[Hub]** and **[Backup_VM]**\n' }), ['context-label', 'context-label']);
  assert.deepEqual(rules({ 'DEPLOY.md': '```\n**[Anything]**\n```\n' }), [], 'code blocks are left alone');
  assert.deepEqual(rules({ 'DEPLOY.md': 'see **[the guide](CLOUDFLARE.md)**\n', 'CLOUDFLARE.md': '# C\n' }), [], 'a bold link is not a label');
});

test('a document that fails to render is reported, not silently skipped', () => {
  // An unbalanced block also breaks the renderer: the directive rule already reports it, with its line.
  assert.deepEqual(rules({ 'DEPLOY.md': '<!-- needs: hermes -->\n\nx\n' }), ['directive']);
  // Any other render error (here a variable name that is not a valid pattern) comes out as its own issue.
  const issues = lintDocs({ 'DEPLOY.md': '# T\n' }, { ...base, variables: ['BROKEN('] });
  assert.deepEqual(issues.map((i) => i.rule), ['render']);
});

test('lowercase <placeholders> are rejected, uppercase ones and directives are fine', () => {
  assert.deepEqual(rules({ 'DEPLOY.md': 'use <user> here\n' }), ['lowercase-placeholder']);
  assert.deepEqual(rules({ 'DEPLOY.md': 'use <PASSWORD> here\n\n<!-- needs: hermes -->\n\nx\n\n<!-- /needs -->\n' }), []);
});

test('links to missing anchors, documents or repo files are reported', () => {
  const files = { 'DEPLOY.md': '## A\n\n[a](#nope) [b](CLOUDFLARE.md#nope) [c](missing.md) [d](stack.sh) [e](#a)\n', 'CLOUDFLARE.md': '## 1. Tunnel\n' };
  const issues = lint(files);
  assert.deepEqual(issues.map((i) => i.rule), ['broken-link', 'broken-link', 'broken-link']);
});

test('unknown or unbalanced directives are reported', () => {
  assert.deepEqual(rules({ 'DEPLOY.md': '<!-- needs: hermes -->\n\nx\n' }), ['directive']);
  assert.deepEqual(rules({ 'DEPLOY.md': '<!-- /needs -->\n' }), ['directive']);
  assert.deepEqual(rules({ 'DEPLOY.md': '<!-- include: foo -->\n' }), ['directive']);
  assert.deepEqual(rules({ 'DEPLOY.md': '<!-- tiers: standard -->\n\nx\n\n<!-- /tiers -->\n' }), ['directive', 'directive']);
});

test('needs blocks may nest, and every named component must exist', () => {
  assert.deepEqual(rules({ 'DEPLOY.md': '<!-- needs: hermes -->\n\n<!-- needs: homer -->\n\nx\n\n<!-- /needs -->\n\n<!-- /needs -->\n' }), []);
  assert.deepEqual(rules({ 'DEPLOY.md': '<!-- needs: hermez -->\n\nx\n\n<!-- /needs -->\n' }), ['directive']);
  assert.deepEqual(rules({ 'DEPLOY.md': '<!-- needs: hermes hermez -->\n\nx\n\n<!-- /needs -->\n' }), ['directive']);
});

test('the Component column accepts "always" or a known component first, and rejects anything else', () => {
  const ok = '| Name | Component |\n|---|---|\n| a | always |\n| b | homer (`ops` network) |\n| c | hermes homer |\n';
  assert.deepEqual(rules({ 'DEPLOY.md': ok }), []);
  assert.deepEqual(rules({ 'DEPLOY.md': '| Name | Component |\n|---|---|\n| a | hermez |\n' }), ['component-column']);
  assert.deepEqual(rules({ 'DEPLOY.md': '| Name | Component |\n|---|---|\n| a |  |\n' }), ['component-column']);
});

test('table rows must have as many cells as the header', () => {
  assert.deepEqual(rules({ 'DEPLOY.md': '| a | b |\n|---|---|\n| 1 | 2 | 3 |\n' }), ['table']);
  assert.deepEqual(rules({ 'DEPLOY.md': '| a | b |\n|---|---|\n| `x | y` | 2 |\n' }), ['table']);
});

test('issues carry the file and line number', () => {
  const [issue] = lint({ 'DEPLOY.md': 'ok\n\nbad **[Nowhere]**\n' });
  assert.equal(issue.file, 'DEPLOY.md');
  assert.equal(issue.line, 3);
});

test('catalog directives must be balanced and not cross needs blocks', () => {
  assert.deepEqual(rules({ 'DEPLOY.md': '<!-- catalog -->\n\nx\n\n<!-- /catalog -->\n' }), []);
  assert.deepEqual(rules({ 'DEPLOY.md': '<!-- catalog -->\n\nx\n' }), ['directive']);
  assert.deepEqual(rules({ 'DEPLOY.md': '<!-- /catalog -->\n' }), ['directive']);
  assert.deepEqual(rules({ 'DEPLOY.md': '<!-- catalog -->\n\n<!-- needs: hermes -->\n\nx\n\n<!-- /catalog -->\n\n<!-- /needs -->\n' }), ['directive', 'directive']);
});
