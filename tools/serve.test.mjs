import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRequest, createSiteServer } from './serve.mjs';

// <base>/dist is served; <base>/dist-other is a sibling whose name starts the same way and must stay out of reach.
let base;
let root;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'serve-'));
  root = join(base, 'dist');
  mkdirSync(join(root, 'guide'), { recursive: true });
  mkdirSync(join(root, 'empty'));
  mkdirSync(join(base, 'dist-other'));
  writeFileSync(join(root, 'index.html'), 'map');
  writeFileSync(join(root, 'guide', 'index.html'), 'guides');
  writeFileSync(join(base, 'dist-other', 'secret.txt'), 'secret');
});
after(() => rmSync(base, { recursive: true, force: true }));

test('files and directory index pages are served', () => {
  assert.deepEqual(resolveRequest(root, '/'), { file: join(root, 'index.html') });
  assert.deepEqual(resolveRequest(root, '/guide/?x=1'), { file: join(root, 'guide', 'index.html') });
  assert.deepEqual(resolveRequest(root, '/guide/index.html#a'), { file: join(root, 'guide', 'index.html') });
});

test('a directory without its trailing slash is redirected, so relative links keep working', () => {
  assert.deepEqual(resolveRequest(root, '/guide'), { redirect: '/guide/' });
  assert.deepEqual(resolveRequest(root, '//guide'), { redirect: '/guide/' }, 'never a protocol-relative Location');
});

test('missing files, directories without an index and paths outside the root are not found', () => {
  assert.equal(resolveRequest(root, '/nope.html'), null);
  assert.equal(resolveRequest(root, '/empty/'), null);
  assert.equal(resolveRequest(root, '/../dist-other/secret.txt'), null);
  assert.equal(resolveRequest(root, '/%2e%2e/dist-other/secret.txt'), null);
  assert.equal(resolveRequest(root, '/..%5cdist-other%5csecret.txt'), null);
  assert.equal(resolveRequest(root, '/%E0%A4%A'), null, 'a malformed escape is not an error');
});

test('the server answers with the right status and content type', async () => {
  const server = createSiteServer(root).listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  try {
    const page = await fetch(url('/guide/'));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.equal(await page.text(), 'guides');
    const moved = await fetch(url('/guide'), { redirect: 'manual' });
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.get('location'), '/guide/');
    assert.equal((await fetch(url('/missing'))).status, 404);
  } finally {
    server.close();
  }
});
