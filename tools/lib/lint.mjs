// Checks that keep the Markdown docs inside the conventions the guide builder relies on.
import { createRenderer, DIRECTIVE, CONTEXT_LABELS } from './markdown.mjs';

const GENERATED = new Set(['tier-table']);

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
const cellCount = (line) => splitRow(line).length;

export function lintDocs(files, { docs, variables = [], templates = {}, components = [], repoFiles = new Set() }) {
  const issues = [];
  const add = (file, line, rule, message) => issues.push({ file, line, rule, message });
  const known = new Set(components);

  // Heading ids per document, to validate anchors. A document that does not render is reported below.
  const ids = {};
  const renderErrors = {};
  for (const [file, text] of Object.entries(files)) {
    const docId = docs[file];
    if (!docId) continue;
    try {
      ids[docId] = new Set(createRenderer({ docs, variables, templates, components }).render(docId, text).headings.map((h) => h.id));
    } catch (error) {
      ids[docId] = new Set();
      renderErrors[file] = error.message;
    }
  }

  for (const [file, text] of Object.entries(files)) {
    const docId = docs[file];
    const lines = text.split(/\r?\n/);
    let fenced = false;
    const opened = []; // { kind, line } of the needs and catalog blocks still open
    let tableHeader = null;
    let componentCol = -1;

    const closeBlock = (kind, n) => {
      const top = opened.pop();
      if (!top) add(file, n, 'directive', `/${kind} without ${kind}`);
      else if (top.kind !== kind) add(file, n, 'directive', `/${kind} does not match the open ${top.kind} block (line ${top.line})`);
    };

    lines.forEach((raw, i) => {
      const n = i + 1;
      const line = raw.trim();
      if (line.startsWith('```')) { fenced = !fenced; tableHeader = null; }

      if (!fenced) {
        for (const m of raw.matchAll(/\*\*\[([^\]\s]+)\]\*\*/g)) {
          if (!Object.hasOwn(CONTEXT_LABELS, m[1])) add(file, n, 'context-label', `Unknown context label [${m[1]}]: use ${Object.keys(CONTEXT_LABELS).map((l) => `[${l}]`).join(', ')} or add it to CONTEXT_LABELS`);
        }
      }

      if (line.startsWith('<!--')) {
        const d = DIRECTIVE.exec(line);
        if (!d) add(file, n, 'directive', `Unknown directive: ${line}`);
        else if (d[1]) {
          opened.push({ kind: 'needs', line: n });
          for (const name of d[2].trim().split(/\s+/)) if (!known.has(name)) add(file, n, 'directive', `Unknown component in needs: ${name}`);
        } else if (d[3]) closeBlock('needs', n);
        else if (d[4]) opened.push({ kind: 'catalog', line: n });
        else if (d[5]) closeBlock('catalog', n);
        else if (!GENERATED.has(d[6])) add(file, n, 'directive', `Unknown generated block: ${d[6]}`);
        return;
      }

      if (/<[a-z][^>]*>/.test(raw)) add(file, n, 'lowercase-placeholder', 'Use an UPPERCASE <NAME> or a declared variable');

      if (fenced) return;

      if (line.startsWith('|')) {
        if (tableHeader === null) {
          tableHeader = cellCount(line);
          componentCol = splitRow(line).findIndex((c) => c.trim().toLowerCase() === 'component');
        } else if (!/^\|[\s:|-]+\|?$/.test(line)) {
          if (cellCount(line) !== tableHeader) {
            add(file, n, 'table', `Row has ${cellCount(line)} cells, header has ${tableHeader} (a pipe inside code splits a cell)`);
          } else if (componentCol >= 0) {
            const first = (/[a-z][a-z0-9-]*/.exec(splitRow(line)[componentCol]) ?? [''])[0];
            if (first !== 'always' && !known.has(first)) add(file, n, 'component-column', `Component must start with "always" or a component name, got "${first}"`);
          }
        }
      } else {
        tableHeader = null;
        componentCol = -1;
      }

      for (const m of raw.matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = m[1];
        if (/^(https?:|mailto:)/.test(href)) continue;
        const [target, frag] = href.split('#');
        const targetId = target === '' ? docId : docs[target];
        if (targetId) {
          if (frag && !(ids[targetId] ?? new Set()).has(`${targetId}-${frag}`)) add(file, n, 'broken-link', `No heading for ${href}`);
        } else if (!repoFiles.has(target)) {
          add(file, n, 'broken-link', `No such file: ${target}`);
        }
      }
    });

    for (const open of opened) add(file, open.line, 'directive', `${open.kind} directive never closed`);
    // A directive issue already explains a render failure, with its line.
    if (renderErrors[file] && !issues.some((i) => i.file === file && i.rule === 'directive')) add(file, 1, 'render', renderErrors[file]);
  }
  return issues;
}
