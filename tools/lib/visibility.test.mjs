import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleHtml, visibleText } from './visibility.mjs';

const active = new Set(['n8n', 'hermes']);

test('blocks whose components are all running stay, others disappear', () => {
  const html = '<p>a</p><div class="needs-block" data-needs="hermes"><p>b</p></div><div class="needs-block" data-needs="fake-db"><p>c</p></div><p>d</p>';
  assert.equal(visibleHtml(html, active), '<p>a</p><div class="needs-block" data-needs="hermes"><p>b</p></div><p>d</p>');
});

test('a block needs every component it names', () => {
  const html = '<div data-needs="hermes crawl4ai">x</div><div data-needs="hermes n8n">y</div>';
  assert.equal(visibleHtml(html, active), '<div data-needs="hermes n8n">y</div>');
});

test('nested blocks are removed together with their parent, and only the hidden child otherwise', () => {
  const inner = '<div data-needs="crawl4ai"><div class="code">z</div></div>';
  assert.equal(visibleHtml(`<div data-needs="fake-db"><div>q</div>${inner}</div>after`, active), 'after');
  assert.equal(visibleHtml(`<div data-needs="hermes"><div>q</div>${inner}</div>after`, active), '<div data-needs="hermes"><div>q</div></div>after');
});

test('table rows and list items can be hidden too', () => {
  const html = '<table><tr><td>a</td></tr><tr data-needs="fake-db"><td>b</td></tr></table><ul><li data-needs="fake-db">x</li><li>y</li></ul>';
  assert.equal(visibleHtml(html, active), '<table><tr><td>a</td></tr></table><ul><li>y</li></ul>');
});

test('visibleText strips tags and collapses whitespace', () => {
  assert.equal(visibleText('<h3 id="x">Title</h3>\n<p>a <code>b</code> &amp; c</p><div data-needs="fake-db">hidden</div>', active), 'Title a b & c');
});

test('catalog blocks can be left out when checking for stray references', () => {
  const html = '<p>keep</p><div class="catalog"><p>Hermes and Fake DB</p><div>inner</div></div><p>end</p>';
  assert.equal(visibleText(html, active, { catalog: false }), 'keep end');
  assert.equal(visibleText(html, active), 'keep Hermes and Fake DB inner end');
});
