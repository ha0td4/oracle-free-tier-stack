// DOM side of the Plan page. The build puts stack.mjs and planner.mjs in front of this file as plain script,
// so planTier, fitPresets, buildTier and the rest are in scope here.
(function () {
  const data = JSON.parse(document.getElementById('plan-data').textContent);
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const kid of kids) node.append(kid);
    return node;
  };
  const fmt = (mib) => `${mib.toLocaleString('en-US')} MiB`;
  const gb = (mib) => `${(mib / 1024).toFixed(1)} GB`;

  const inputs = { ram: $('ram'), ocpu: $('ocpu'), pagesize: $('pagesize'), profile: $('host-profile'), overhead: $('overhead'), name: $('tier-name') };
  const picks = [...document.querySelectorAll('input.pick')];
  const overrides = {};
  const cpuOverrides = {};
  let overheadTouched = false;

  const machine = () => {
    const usable = usableMiB(Number(inputs.ram.value));
    const typed = Number(inputs.overhead.value);
    const overhead = overheadTouched && Number.isFinite(typed) && inputs.overhead.value !== '' ? typed : hostOverheadMiB(usable, inputs.profile.value);
    return { usableMiB: usable, hostOverheadMiB: overhead, pageSize4k: inputs.pagesize.value === '4k', ocpu: Number(inputs.ocpu.value) };
  };

  function renderBudget(m) {
    const b = budget(m);
    const box = $('budget');
    box.replaceChildren(
      el('div', { class: 'stats' },
        stat(fmt(m.usableMiB), 'usable RAM (estimate)'),
        stat(fmt(m.hostOverheadMiB), 'used by the host before any container'),
        stat(fmt(b.ruleMiB), `${Math.round(SHARE * 100)}% rule`),
        stat(fmt(b.hardMiB), 'left after the host'),
        stat(fmt(b.availableMiB), 'budget for container limits', true),
      ),
    );
    if (b.availableMiB === 0) box.append(el('p', { class: 'note bad', text: 'The host alone uses all the RAM. Pick a leaner host setup or a larger machine.' }));
    if (m.ocpu < 1) box.append(el('p', { class: 'note warn', text: 'A fraction of one OCPU is burstable: the CPU is shared and throttled under load. Prefer services that idle (n8n, cloudflared) over Hermes and Crawl4AI.' }));
    return b;
  }
  const stat = (value, label, key = false) => el('div', { class: key ? 'stat key' : 'stat' }, el('b', { text: value }), el('span', { text: label }));

  function fillPicks(names) {
    const want = new Set(names);
    for (const box of picks) box.checked = want.has(box.value);
  }
  const selected = () => picks.filter((p) => p.checked).map((p) => p.value);

  function renderPresets(m) {
    const fit = fitPresets(data.presets, m);
    const best = recommend(fit);
    const rows = fit.map((f) => {
      const preset = data.presets.find((p) => p.name === f.name);
      const use = el('button', { type: 'button', class: 'use', 'data-preset': f.name, text: 'Use as start' });
      use.addEventListener('click', () => {
        fillPicks(preset.profiles);
        for (const o of [overrides, cpuOverrides]) for (const k of Object.keys(o)) delete o[k];
        Object.assign(overrides, preset.start.mem);
        Object.assign(cpuOverrides, preset.start.cpus);
        renderCustom();
        $('custom').scrollIntoView({ behavior: 'smooth' });
      });
      return el('tr', { class: f.name === best ? 'best' : '' },
        el('th', { scope: 'row', text: f.name }),
        el('td', { class: 'num', text: fmt(f.totalMiB) }),
        el('td', {}, el('span', { class: `chip ${f.status}`, text: f.status })),
        el('td', { text: f.notes.join('; ') || (f.name === best ? 'Largest tier that fits' : '') }),
        el('td', {}, use),
      );
    });
    const head = el('tr', {}, ...['Tier', 'Container limits', 'Fit', 'Notes', ''].map((t) => el('th', { scope: 'col', text: t })));
    $('preset-list').replaceChildren(
      best
        ? el('p', { class: 'verdict ok' }, 'Recommended: ', el('b', { text: best }), ` (${fmt(fit.find((f) => f.name === best).totalMiB)} of ${fmt(budget(m).availableMiB)}).`)
        : el('p', { class: 'verdict bad', text: 'No ready-made tier fits this machine as set up. Build a smaller one below, use a leaner host setup, or pick a larger machine.' }),
      el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, head), el('tbody', {}, ...rows))),
    );
    return fit;
  }

  function renderCustom() {
    const m = machine();
    const b = budget(m);
    const names = selected();
    const result = buildTier({ services: data.services, components: data.components, selected: names, memOverrides: overrides, cpuOverrides, pageSize4k: m.pageSize4k, name: inputs.name.value.trim() || 'mine' });

    for (const box of picks) {
      const forced = result.added.includes(box.value);
      box.closest('label').classList.toggle('forced', forced);
      if (forced) box.checked = true;
    }

    const rows = result.services.map((s) => {
      const svc = data.services.find((x) => x.name === s.name);
      const cell = svc.memVar
        ? el('input', { type: 'number', min: '32', step: '16', value: String(overrides[s.name] ?? s.memMiB), 'data-service': s.name, 'aria-label': `${s.name} memory limit in MiB` })
        : el('span', { text: String(s.memMiB) });
      if (svc.memVar) cell.addEventListener('change', () => {
        const v = Number(cell.value);
        if (Number.isFinite(v) && v >= 32) overrides[s.name] = Math.round(v); else delete overrides[s.name];
        renderCustom();
      });
      return el('tr', {}, el('th', { scope: 'row', text: s.name }), el('td', { class: 'num' }, cell));
    });
    $('limits').replaceChildren(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Container' }), el('th', { scope: 'col', text: 'Memory limit (MiB)' }))),
      el('tbody', {}, ...rows))));

    const over = result.totalMiB - b.availableMiB;
    const status = result.totalMiB <= b.availableMiB ? 'fits' : result.totalMiB <= b.hardMiB ? 'tight' : 'no';
    const lines = [];
    lines.push(el('p', { class: `verdict ${status === 'fits' ? 'ok' : status === 'tight' ? 'warn' : 'bad'}` },
      el('b', { text: fmt(result.totalMiB) }), ` of ${fmt(b.availableMiB)} budget (${gb(result.totalMiB)}): `, el('span', { class: `chip ${status}`, text: status }),
      status === 'tight' ? ` ${over} MiB over the ${Math.round(SHARE * 100)}% rule, still inside what the host leaves.` : status === 'no' ? ` ${over} MiB over the budget.` : ''));
    if (result.added.length) lines.push(el('p', { class: 'note', text: `Added because another component needs it: ${result.added.join(', ')}.` }));
    for (const w of result.warnings) lines.push(el('p', { class: 'note bad', text: `${w}: this machine has 64K pages.` }));
    if (m.ocpu < 1 && names.some((n) => n === 'hermes' || n === 'crawl4ai')) lines.push(el('p', { class: 'note warn', text: 'Hermes and Crawl4AI need real CPU; on a fractional OCPU they will be slow and may time out.' }));
    if (status !== 'no' && names.length === 0) lines.push(el('p', { class: 'note', text: 'Only cloudflared runs. Tick at least one component.' }));

    const copy = el('button', { type: 'button', class: 'copy', text: 'Copy' });
    copy.addEventListener('click', () => {
      const done = () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(result.env).then(done, () => selectEnv());
      else selectEnv();
    });
    const code = el('code', { text: result.env });
    const selectEnv = () => { const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
    const name = inputs.name.value.trim() || 'mine';
    lines.push(el('div', { class: 'env' },
      el('header', {}, el('b', { text: `tiers/${name}.env` }), copy),
      el('pre', {}, code)));
    lines.push(el('p', { class: 'note', text: `Save it as tiers/${name}.env in the repository on the VM, then run ./stack.sh tier ${name}. Limits are guesses until you read ./stack.sh stats under load.` }));
    $('custom-result').replaceChildren(...lines);
  }

  function renderAll() {
    const m = machine();
    if (!overheadTouched) inputs.overhead.value = String(hostOverheadMiB(m.usableMiB, inputs.profile.value));
    renderBudget(machine());
    renderPresets(machine());
    renderCustom();
  }

  for (const id of ['ram', 'ocpu', 'pagesize', 'profile']) inputs[id].addEventListener('change', renderAll);
  inputs.overhead.addEventListener('input', () => { overheadTouched = inputs.overhead.value !== ''; renderAll(); });
  inputs.name.addEventListener('input', () => {
    inputs.name.value = inputs.name.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    renderCustom();
  });
  for (const box of picks) box.addEventListener('change', renderCustom);

  const first = machine();
  const best = recommend(fitPresets(data.presets, first)) ?? data.presets.at(-1).name;
  fillPicks(data.presets.find((p) => p.name === best).profiles);
  renderAll();
})();
