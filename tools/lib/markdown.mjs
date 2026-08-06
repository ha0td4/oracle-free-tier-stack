// Markdown to HTML for the guide: marked plus the repo conventions (placeholders, labels, directives, links).
import { Marked } from 'marked';

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// GitHub-style heading slug: lower case, drop punctuation, spaces to hyphens.
export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

// <!-- needs: a b -->  ...  <!-- /needs -->   hide the block unless every named component runs in the tier
// <!-- catalog --> ... <!-- /catalog -->      reference content that is the same for every tier (never hidden, not checked for stray names)
// <!-- generated: name -->                     placeholder the builder fills in
export const DIRECTIVE = /^<!--\s*(?:(needs):\s*([a-z0-9 -]+?)|(\/needs)|(catalog)|(\/catalog)|generated:\s*([a-z-]+?))\s*-->\s*$/;

function plainText(tokens) {
  return tokens.map((t) => (t.tokens ? plainText(t.tokens) : (t.text ?? t.raw ?? ''))).join('').replace(/`/g, '');
}

// Components named in a table cell ("homer (`ops` network)" gives ["homer"]; "always" gives []).
export function componentsIn(text, components) {
  const known = new Set(components);
  return [...new Set((text.match(/[a-z][a-z0-9-]*/g) ?? []).filter((w) => known.has(w)))];
}

// A step heading starts with its label: "A1. Check the VM". Other ### headings of a step guide (design notes) are not steps.
export const STEP_LABEL = /^[A-Z]\d+\. /;

// Context labels ("run this on ..."), written **[Host]** in the docs, and the class of the chip each becomes.
// The lint rejects any other **[Label]**; add a label here and a .ctx-* rule in tools/guide/style.css together.
export const CONTEXT_LABELS = { Host: 'ctx-host', Remote_VM: 'ctx-vm', Hub_VM: 'ctx-hub' };
const CONTEXT = new RegExp(`\\[(${Object.keys(CONTEXT_LABELS).join('|')})\\]`, 'g');

export function createRenderer({ docs, variables = [], templates = {}, components = [], stepDocs = ['deploy'] }) {
  const varPattern = variables.length
    ? new RegExp(`(?<![A-Za-z0-9_])(${[...variables].sort((a, b) => b.length - a.length).join('|')})(?![A-Za-z0-9_=])`, 'g')
    : null;

  const decorate = (escaped) => (varPattern ? escaped.replace(varPattern, '<span class="var" data-var="$1">$1</span>') : escaped);
  const chips = (escaped) => escaped.replace(CONTEXT, (_, label) => `<span class="ctx ${CONTEXT_LABELS[label]}">${label}</span>`);

  function resolveHref(href, docId) {
    if (/^(https?:|mailto:)/.test(href)) return { external: href };
    if (href.startsWith('#')) return { anchor: `${docId}-${href.slice(1)}` };
    const [file, frag] = href.split('#');
    if (docs[file]) return { anchor: frag ? `${docs[file]}-${frag}` : docs[file] };
    if (templates[file]) return { anchor: templates[file] };
    return { file };
  }

  function render(docId, markdown) {
    const headings = [];
    const seen = new Map();
    const open = []; // stack of { kind, names } for the enclosing needs and catalog blocks
    const marked = new Marked({ gfm: true });
    marked.use({
      renderer: {
        heading({ tokens, depth }) {
          const text = plainText(tokens);
          let id = depth === 1 ? docId : `${docId}-${slug(text)}`;
          const n = seen.get(id) ?? 0;
          seen.set(id, n + 1);
          if (n > 0) id = `${id}-${n}`;
          headings.push({ depth, text, id, needs: [...new Set(open.flatMap((o) => o.names))] });
          const inner = this.parser.parseInline(tokens);
          const step = depth === 3 && stepDocs.includes(docId) && STEP_LABEL.test(text)
            ? `<input type="checkbox" class="step-done" data-step="${id}" aria-label="Mark done"> `
            : '';
          return `<h${depth} id="${id}">${step}${inner}</h${depth}>\n`;
        },
        code({ text, lang }) {
          const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
          return `<div class="code"><button type="button" class="copy" aria-label="Copy to clipboard">Copy</button><pre><code${cls}>${decorate(escapeHtml(text))}</code></pre></div>\n`;
        },
        codespan({ text }) {
          return `<code>${decorate(escapeHtml(text))}</code>`;
        },
        text(token) {
          if (token.tokens) return this.parser.parseInline(token.tokens);
          return chips(decorate(token.escaped ? token.text : escapeHtml(token.text)));
        },
        link({ href, tokens }) {
          const r = resolveHref(href, docId);
          if (r.external) return `<a href="${escapeHtml(r.external)}" target="_blank" rel="noopener">${this.parser.parseInline(tokens)}</a>`;
          if (r.anchor) return `<a href="#${r.anchor}">${this.parser.parseInline(tokens)}</a>`;
          return `<code>${escapeHtml(r.file)}</code>`;
        },
        html({ text }) {
          return escapeHtml(text);
        },
        // A column titled "Component" decides which components a row needs; the row is hidden when one of them is not in the tier.
        table(token) {
          const cell = (c, tag) => `<${tag}${c.align ? ` align="${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</${tag}>`;
          const col = token.header.findIndex((h) => plainText(h.tokens).trim().toLowerCase() === 'component');
          const head = `<tr>\n${token.header.map((c) => cell(c, 'th')).join('\n')}\n</tr>`;
          const rows = token.rows.map((row) => {
            const needs = col >= 0 ? componentsIn(plainText(row[col].tokens), components) : [];
            const attr = needs.length ? ` data-needs="${needs.join(' ')}"` : '';
            return `<tr${attr}>\n${row.map((c) => cell(c, 'td')).join('\n')}\n</tr>`;
          }).join('\n');
          return `<div class="tbl"><table>\n<thead>\n${head}\n</thead>\n<tbody>${rows}</tbody></table></div>\n`;
        },
      },
    });

    // Split on directive comment lines, render each chunk on its own.
    const out = [];
    let chunk = [];
    const flush = () => {
      if (chunk.join('').trim()) out.push(marked.parse(chunk.join('\n')));
      chunk = [];
    };
    const close = (kind) => {
      const top = open.pop();
      if (!top) throw new Error(`${docId}: /${kind} without ${kind}`);
      if (top.kind !== kind) throw new Error(`${docId}: /${kind} does not match the open ${top.kind} block`);
      out.push('</div>');
    };
    for (const line of markdown.split(/\r?\n/)) {
      const d = DIRECTIVE.exec(line.trim());
      if (!d) { chunk.push(line); continue; }
      flush();
      if (d[1]) {
        const names = d[2].trim().split(/\s+/);
        open.push({ kind: 'needs', names });
        out.push(`<div class="needs-block" data-needs="${names.join(' ')}">`);
      } else if (d[3]) {
        close('needs');
      } else if (d[4]) {
        open.push({ kind: 'catalog', names: [] });
        out.push('<div class="catalog">');
      } else if (d[5]) {
        close('catalog');
      } else {
        out.push(`<div data-generated="${d[6]}"></div>`);
      }
    }
    flush();
    if (open.length) throw new Error(`${docId}: ${open.at(-1).kind} directive never closed`);
    return { html: out.join('\n'), headings };
  }

  return { render };
}
