// What a reader sees in the guides for one tier: blocks, rows and items that need a component the tier does not run are removed.
// The browser does the same with CSS (see tools/guide/app.js); this is the server-side twin used by the tests.

const TAG = /<(\/?)(div|tr|li)\b([^>]*)>/g;
const NEEDS = /\sdata-needs="([^"]*)"/;
const CATALOG = /\sclass="catalog"/;

// catalog: false also drops the reference blocks that are the same for every tier (used when checking for stray names).
export function visibleHtml(html, active, { catalog = true } = {}) {
  const met = (needs) => needs.split(/\s+/).filter(Boolean).every((name) => active.has(name));
  let out = '';
  let last = 0;
  let skip = null; // { tag, depth } while inside a hidden element
  for (const m of html.matchAll(TAG)) {
    const [raw, closing, tag, attrs] = m;
    if (!skip) out += html.slice(last, m.index);
    last = m.index + raw.length;
    if (skip) {
      if (tag === skip.tag) skip.depth += closing ? -1 : 1;
      if (skip.depth === 0) skip = null;
      continue;
    }
    const needs = !closing && NEEDS.exec(attrs);
    if ((needs && !met(needs[1])) || (!catalog && !closing && CATALOG.test(attrs))) { skip = { tag, depth: 1 }; continue; }
    out += raw;
  }
  if (!skip) out += html.slice(last);
  return out;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

export function visibleText(html, active, options) {
  return visibleHtml(html, active, options)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e])
    .replace(/\s+/g, ' ')
    .trim();
}
