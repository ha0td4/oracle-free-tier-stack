// The Plan route: sizing data from the repository files, the page markup and the script that runs it.
import { readFileSync } from 'node:fs';
import { componentRows, isHubService } from './repo.mjs';
import { parseCompose, parseTierEnv, planTier } from './stack.mjs';
import { HOST_PROFILES, SHARE, buildPresetStart } from '../guide/planner.mjs';

const here = new URL('../guide/', import.meta.url);
const lib = new URL('./', import.meta.url);
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The hub runs on its own VM (HUB_SERVICES): it is not something to size this machine for.
export function buildPlanData(repo) {
  const services = parseCompose(repo.compose).filter((s) => !isHubService(s.name));
  const names = services.map((s) => s.name);
  const rows = componentRows(repo.files['CUSTOMIZE.md'], names).filter((r) => !isHubService(r.name));
  const alone = (profiles) => planTier(services, { profiles, vars: {} });
  const base = alone([]).totalMiB; // cloudflared, which always runs
  const components = rows.map((r) => {
    const plan = alone([r.name]);
    return {
      name: r.name,
      note: r.note,
      requires: r.requires,
      needs4k: r.needs4k,
      services: plan.services.map((s) => s.name).filter((n) => n !== 'cloudflared'),
      memMiB: plan.totalMiB - base,
    };
  });
  const presets = repo.tiers.map((name) => {
    const tier = parseTierEnv(repo.files[`tiers/${name}.env`]);
    return {
      name,
      profiles: tier.profiles,
      totalMiB: planTier(services, tier).totalMiB,
      start: buildPresetStart(services, tier),
      needs4k: components.filter((c) => c.needs4k && tier.profiles.includes(c.name)).map((c) => c.name),
    };
  });
  return { share: SHARE, hostProfiles: HOST_PROFILES, presets, components, services };
}

// The sizing code runs in the page as plain script: drop the module syntax of the two files it is made of.
// Handles import statements over one or more lines and `export` in front of a declaration; anything else
// (export lists, export default, dynamic import) is refused so it cannot reach the page half converted.
export function plain(source, name = 'module') {
  const out = source
    .replace(/^import\s+(?:[^;'"]*?\s+from\s+)?(['"])[^'"]+\1\s*;?[ \t]*\r?\n?/gm, '')
    .replace(/^export (?=(?:async )?(?:function|const|let|class)\b)/gm, '');
  const left = /^\s*(import|export)\b.*$/m.exec(out);
  if (left) throw new Error(`${name}: module syntax the plan page cannot inline: ${left[0].trim()}`);
  return out;
}
export const planScript = () => [
  plain(readFileSync(new URL('stack.mjs', lib), 'utf8'), 'tools/lib/stack.mjs'),
  plain(readFileSync(new URL('planner.mjs', here), 'utf8'), 'tools/guide/planner.mjs'),
  readFileSync(new URL('plan.js', here), 'utf8'),
].join('\n');

const RAM_CHOICES = [1, 2, 4, 6, 8, 12, 16, 24];
const OCPU_CHOICES = [
  ['0.125', '1/8 OCPU, burstable (the free AMD Micro)'],
  ['1', '1 OCPU'],
  ['2', '2 OCPU'],
  ['4', '4 OCPU'],
];

export function planMain(data) {
  const ram = RAM_CHOICES.map((gb) => `<option value="${gb}"${gb === 12 ? ' selected' : ''}>${gb} GB</option>`).join('');
  const ocpu = OCPU_CHOICES.map(([v, label]) => `<option value="${v}"${v === '2' ? ' selected' : ''}>${label}</option>`).join('');
  const profiles = Object.entries(data.hostProfiles).map(([k, p]) => `<option value="${k}">${escText(p.label)}</option>`).join('');
  const picks = data.components.map((c) => `<label class="pick" data-component-pick="${c.name}"><input type="checkbox" class="pick" value="${c.name}"><span><b>${c.name}</b> <em>${c.memMiB} MiB</em><small>${escText(c.note)}</small></span></label>`).join('\n');
  return `    <header class="top compact">
      <div class="eyebrow">Plan · size a machine</div>
      <h1>Which tier fits this machine?</h1>
      <p class="lede">Enter what the machine has. The page checks every ready-made tier against a RAM budget and builds a tier file for any mix of components.
      Figures marked estimate are not measured on your machine: confirm with <code>free -m</code> and <code>./stack.sh stats</code>.</p>
    </header>

    <section id="machine">
      <h2>Your machine</h2>
      <div class="form">
        <div class="field"><label for="ram">RAM</label><select id="ram">${ram}</select></div>
        <div class="field"><label for="ocpu">CPU</label><select id="ocpu">${ocpu}</select></div>
        <div class="field"><label for="pagesize">Kernel page size</label><select id="pagesize"><option value="4k" selected>4K (getconf PAGESIZE prints 4096)</option><option value="64k">64K (prints 65536)</option></select></div>
        <div class="field"><label for="host-profile">Host setup</label><select id="host-profile">${profiles}</select></div>
        <div class="field"><label for="overhead">Host RAM use in MiB (estimate)</label><input id="overhead" type="number" min="0" step="10" inputmode="numeric"><small>Filled in from the setup and the RAM. Type your own number once you measured it with <code>free -m</code> after <code>setup-host.sh</code>.</small></div>
      </div>
      <div id="budget" class="capcard" aria-live="polite"></div>
    </section>

    <section id="presets">
      <h2>Ready-made tiers</h2>
      <p class="intro">From the largest to the smallest. <b>fits</b> is inside the budget, <b>tight</b> is over the 85% rule but still leaves the host its RAM, <b>no</b> does not fit.</p>
      <div id="preset-list" aria-live="polite"></div>
    </section>

    <section id="custom">
      <h2>Build your own tier</h2>
      <p class="intro">Tick the components you want, change a limit if you know better, and copy the tier file. <code>cloudflared</code> always runs. A component that another one needs is added for you.</p>
      <div class="picks" id="picks">
${picks}
      </div>
      <div id="limits" class="limits"></div>
      <div class="field"><label for="tier-name">Tier name</label><input id="tier-name" type="text" value="mine" pattern="[a-z0-9-]+" maxlength="24" autocomplete="off"></div>
      <div id="custom-result" aria-live="polite"></div>
    </section>`;
}

export const planToc = `    <div class="brand">Plan</div>
    <ol>
      <li><a href="#machine">Your machine</a></li>
      <li><a href="#presets">Ready-made tiers</a></li>
      <li><a href="#custom">Build your own</a></li>
    </ol>`;
