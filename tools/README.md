# tools: the site builder

`npm run build` turns the Markdown docs, the compose files and the tier files into a static site in `dist/`:

| Page | Source |
|---|---|
| `dist/index.html`, the stack map | `guide/map.html` (written by hand) plus facts computed from the compose and tier files |
| `dist/guide/index.html`, the guides | every document in `DOCS` (`lib/repo.mjs`), rendered by `lib/markdown.mjs` |
| `dist/plan/index.html`, the plan page | the Components table of CUSTOMIZE.md and the compose limits; logic in `guide/planner.mjs` |

The pages have no external scripts, styles or fonts. The build lints the docs first and stops on any issue.
It writes `dist/.stack-guide-build` and empties `dist/` before each build. A directory outside `dist/` is emptied only when it holds that
marker: a mistyped `--out` cannot wipe a directory the builder did not write.

## Scripts

| Script | What it does |
|---|---|
| `npm test` | every test, including `stack-sh.test.mjs` (runs `stack.sh` under bash, about 6 minutes on Windows) |
| `npm run test:fast` | every test except `stack-sh.test.mjs` |
| `npm run build` | build `dist/` (`node tools/build-guide.mjs --out DIR --guide-path P --plan-path P --artifact`) |
| `npm run check` | `test`, then `build` |
| `npm run serve` | serve `dist/` on `http://127.0.0.1:4173` (`tools/serve.mjs`) |
| `npm run clean` | delete `dist/` |

## Directives in the docs

| Directive | Meaning |
|---|---|
| `<!-- needs: a b -->` ... `<!-- /needs -->` | shown only in tiers that run every named component; blocks nest |
| `<!-- catalog -->` ... `<!-- /catalog -->` | reference content that is the same for every tier: never hidden, and the stray-name tests skip it |
| `<!-- generated: tier-table -->` | the builder fills in the tier table |
| a table column titled `Component` | each row is hidden unless its components run; the cell must start with `always` or a component name |
| `**[Host]**`, `**[Remote_VM]**`, `**[Hub_VM]**` | context labels, rendered as chips. `CONTEXT_LABELS` in `lib/markdown.mjs` lists them; the lint rejects any other `**[Label]**`. A new label needs an entry there and a `.ctx-*` rule in `guide/style.css` |

Component names are the compose service names. The lint also checks links, anchors, table cell counts and placeholders (UPPERCASE only).

## Registries to update with the stack

All in `lib/build.mjs` unless noted. The build throws when one is missing an entry.

- `GROUP`: the colour group of every container a tier can run (the tier table and the RAM bar). Each group needs a `--c-<group>` variable in
  the light theme and in both dark theme blocks of `guide/style.css`; a test checks all three.
- `COMPONENT_STEP`: the guide step that sets each component up (`D5`, or `#anchor` for a section). The map links each component there.
- `HUB_SERVICES` and `HUB_STEP` (`lib/repo.mjs`): the monitoring hub. It runs on its own VM as systemd services (`host/hub/deploy-hub.sh`),
  not as Compose containers. A compose service with one of these names is left out of the map, `GROUP`, `COMPONENT_STEP` and the plan page.
- `TOC_GROUPS`: the sidebar groups of the guides. Every document panel must belong to one.

## Keeping map.html in sync

`guide/map.html` is drawn by hand: layers, the SVG diagram and the route tables. The tests catch drift in these places:

- every compose service (except the hub) appears as `data-component`, and no unknown name does;
- the hub's items carry `data-hub` (never `data-component`, so no tier dims them) and name exactly `HUB_SERVICES`;
- every route of CLOUDFLARE.md B6 has its own row with the same address and a `data-component` equal to its Component column;
- the retention stated for Prometheus, Loki and Tempo matches the defaults at the top of `host/hub/deploy-hub.sh`;
- no old label or placeholder appears.

These are checked by hand: the diagram geometry and arrows, the internal and localhost address tables, ports, and the wording.
Open the map after `npm run build && npm run serve` and switch tiers: components a tier does not run turn grey, the hub stays.
The routes, containers and RAM facts in the header are computed and need no edit.
