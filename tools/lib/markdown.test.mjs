import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slug, createRenderer } from './markdown.mjs';

const docs = { 'DEPLOY.md': 'deploy', 'CLOUDFLARE.md': 'cloudflare', 'README.md': 'about' };
const ctx = {
  docs,
  variables: ['DOMAIN', 'PUBLIC_IP', 'SSH_USER', 'TELEGRAM_BOT_TOKEN'],
  templates: { 'config/dash/config.yml': 'tpl-config-dash-config-yml' },
  components: ['n8n', 'hermes', 'homer', 'crawl4ai', 'searxng', 'pocket-id'],
};
const render = (md, docId = 'deploy') => createRenderer(ctx).render(docId, md);

test('slug follows the GitHub heading rules', () => {
  assert.equal(slug('Add / remove a person (checklist)'), 'add--remove-a-person-checklist');
  assert.equal(slug('C2. Create the Cloudflare Tunnel (token only)'), 'c2-create-the-cloudflare-tunnel-token-only');
  assert.equal(slug('2. Access (free Zero Trust, up to 50 users)'), '2-access-free-zero-trust-up-to-50-users');
});

test('headings get ids prefixed with the document id and are collected', () => {
  const { html, headings } = render('## A. Accounts\n\n### A1. Check the VM\n');
  assert.match(html, /<h2 id="deploy-a-accounts">/);
  assert.match(html, /<h3 id="deploy-a1-check-the-vm">/);
  assert.deepEqual(headings.map((h) => [h.depth, h.id]), [[2, 'deploy-a-accounts'], [3, 'deploy-a1-check-the-vm']]);
});

test('links between documents become in-page anchors', () => {
  const h = (md, id) => render(md, id).html;
  assert.match(h('[x](CLOUDFLARE.md#12-publish-the-routes)'), /href="#cloudflare-12-publish-the-routes"/);
  assert.match(h('[x](DEPLOY.md)'), /href="#deploy"/);
  assert.match(h('[x](#local-part)', 'cloudflare'), /href="#cloudflare-local-part"/);
  assert.match(h('[x](https://example.com/a)'), /href="https:\/\/example.com\/a"/);
});

test('links to template files point at the config template panel, other repo files become plain code', () => {
  assert.match(render('[c](config/dash/config.yml)').html, /href="#tpl-config-dash-config-yml"/);
  const other = render('[s](stack.sh)').html;
  assert.doesNotMatch(other, /<a /);
  assert.match(other, /<code>stack\.sh<\/code>/);
});

test('[Host], [Remote_VM] and [Hub_VM] become label chips', () => {
  const { html } = render('**[Host]**\n\nRun on **[Remote_VM]** now, then on **[Hub_VM]**');
  assert.match(html, /<span class="ctx ctx-host">Host<\/span>/);
  assert.match(html, /<span class="ctx ctx-vm">Remote_VM<\/span>/);
  assert.match(html, /<strong><span class="ctx ctx-hub">Hub_VM<\/span><\/strong>/);
});

test('an unknown label is left as text: the lint reports it', () => {
  assert.match(render('**[Other_VM]**').html, /<strong>\[Other_VM\]<\/strong>/);
});

test('declared variables are highlighted in prose and code, nothing else is', () => {
  const { html } = render('Open https://n8n.DOMAIN now\n\n```bash\nssh SSH_USER@PUBLIC_IP\nDOMAIN=example.com\necho CF_TUNNEL_TOKEN\n```\n');
  assert.match(html, /n8n\.<span class="var" data-var="DOMAIN">DOMAIN<\/span>/);
  assert.match(html, /<span class="var" data-var="SSH_USER">SSH_USER<\/span>@<span class="var" data-var="PUBLIC_IP">PUBLIC_IP<\/span>/);
  assert.match(html, /\nDOMAIN=example\.com\n/);
  assert.doesNotMatch(html, /data-var="CF_TUNNEL_TOKEN"/);
  assert.doesNotMatch(html, /data-var="TELEGRAM_BOT_TOKEN"/);
});

test('code blocks are escaped and get a copy button with the raw text', () => {
  const { html } = render('```bash\necho "<NAME>" && ls\n```\n');
  assert.match(html, /<div class="code"><button type="button" class="copy"/);
  assert.match(html, /&lt;NAME&gt;/);
  assert.match(html, /<code class="language-bash">/);
});

test('needs directives wrap the enclosed blocks', () => {
  const { html } = render('before\n\n<!-- needs: hermes crawl4ai -->\n\ninside\n\n<!-- /needs -->\n\nafter\n');
  assert.match(html, /<div class="needs-block" data-needs="hermes crawl4ai">\s*<p>inside<\/p>\s*<\/div>/);
  assert.match(html, /<p>before<\/p>/);
  assert.match(html, /<p>after<\/p>/);
});

test('generated markers become placeholders the builder fills in', () => {
  assert.match(render('<!-- generated: tier-table -->\n').html, /<div data-generated="tier-table"><\/div>/);
});

test('inline code and prose are escaped exactly once', () => {
  const { html } = render('Use `<NAME>` and A & B');
  assert.match(html, /<code>&lt;NAME&gt;<\/code>/);
  assert.match(html, /A &amp; B/);
  assert.doesNotMatch(html, /&amp;amp;/);
});

test('steps in the deploy document get a done checkbox, other documents do not', () => {
  assert.match(render('### A1. Check\n').html, /<input type="checkbox" class="step-done" data-step="deploy-a1-check"/);
  assert.doesNotMatch(render('### Notes\n', 'cloudflare').html, /step-done/);
});

test('tables are wrapped for horizontal scrolling', () => {
  assert.match(render('| a | b |\n|---|---|\n| 1 | 2 |\n').html, /<div class="tbl"><table>[\s\S]*<\/table><\/div>/);
});

test('needs blocks nest, and a heading inside records every component it depends on', () => {
  const md = '<!-- needs: hermes -->\n\n### D3. Hermes\n\n<!-- needs: crawl4ai -->\n\n### Page reading\n\n<!-- /needs -->\n\n### Back in Hermes\n\n<!-- /needs -->\n\n### Always\n';
  const { html, headings } = render(md);
  assert.equal((html.match(/<div class="needs-block"/g) ?? []).length, 2);
  assert.deepEqual(headings.map((h) => [h.text, h.needs]), [
    ['D3. Hermes', ['hermes']],
    ['Page reading', ['hermes', 'crawl4ai']],
    ['Back in Hermes', ['hermes']],
    ['Always', []],
  ]);
});

test('table rows with a Component column carry the components they need', () => {
  const md = '| Name | Component |\n|---|---|\n| a | always |\n| b | hermes |\n| c | homer (`ops` network) |\n| d | crawl4ai hermes |\n';
  const { html } = render(md);
  assert.match(html, /<tr>\s*<td>a<\/td>/);
  assert.match(html, /<tr data-needs="hermes">\s*<td>b<\/td>/);
  assert.match(html, /<tr data-needs="homer">\s*<td>c<\/td>/);
  assert.match(html, /<tr data-needs="crawl4ai hermes">\s*<td>d<\/td>/);
});

test('tables without a Component column are left alone', () => {
  const { html } = render('| Name | Note |\n|---|---|\n| a | hermes |\n');
  assert.doesNotMatch(html, /data-needs/);
  assert.match(html, /<div class="tbl"><table>/);
});

test('table alignment and inline formatting survive the custom table renderer', () => {
  const { html } = render('| a | b |\n|:--|--:|\n| **x** | `y` |\n');
  assert.match(html, /<th align="left">a<\/th>/);
  assert.match(html, /<td align="right"><code>y<\/code><\/td>/);
  assert.match(html, /<strong>x<\/strong>/);
});

test('catalog blocks are marked as tier-independent reference content', () => {
  const { html } = render('<!-- catalog -->\n\n### Every component\n\ntext\n\n<!-- /catalog -->\n', 'team');
  assert.match(html, /<div class="catalog">\s*<h3 id="team-every-component">Every component<\/h3>\s*<p>text<\/p>\s*<\/div>/);
});

test('a heading inside a needs block that wraps a whole document records the needs on the H1 too', () => {
  const { headings } = render('<!-- needs: hermes pocket-id -->\n\n# Team\n\n## Roles\n\n<!-- /needs -->\n', 'team');
  assert.deepEqual(headings.map((h) => [h.depth, h.needs]), [[1, ['hermes', 'pocket-id']], [2, ['hermes', 'pocket-id']]]);
});
