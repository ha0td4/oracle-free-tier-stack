#!/usr/bin/env node
// Serves the built site (dist/ by default) on 127.0.0.1 for a local preview. Static files only, no dependencies.
// Usage: node tools/serve.mjs [--dir dist] [--port 4173]
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const stat = (path) => { try { return statSync(path); } catch { return null; } };

// The file a URL path maps to inside root, or a redirect for a directory without its trailing slash
// (the pages link with relative paths, so /guide must become /guide/). null: not found or outside root.
export function resolveRequest(root, urlPath) {
  const raw = urlPath.split('?')[0].split('#')[0];
  let path;
  try { path = decodeURIComponent(raw); } catch { return null; }
  if (path.includes('\0')) return null;
  const target = resolve(join(root, path));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const info = stat(target);
  if (info?.isDirectory()) {
    // One leading slash: a Location of //name would leave the site.
    if (!path.endsWith('/')) return { redirect: `/${raw.replace(/^\/+/, '')}/` };
    const index = join(target, 'index.html');
    return stat(index)?.isFile() ? { file: index } : null;
  }
  return info?.isFile() ? { file: target } : null;
}

export function createSiteServer(root) {
  const base = resolve(root);
  return createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
    const hit = resolveRequest(base, req.url ?? '/');
    if (!hit) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    if (hit.redirect) { res.writeHead(301, { location: hit.redirect }); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(hit.file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(hit.file).on('error', () => res.destroy()).pipe(res);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { dir: { type: 'string', default: 'dist' }, port: { type: 'string', default: '4173' } } });
  const root = resolve(values.dir);
  if (!stat(root)?.isDirectory()) {
    console.error(`${root} does not exist: run npm run build first`);
    process.exit(1);
  }
  createSiteServer(root).listen(Number(values.port), '127.0.0.1', () => console.log(`Serving ${root} at http://127.0.0.1:${values.port}/`));
}
