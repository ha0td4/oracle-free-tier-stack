// Behaviour shared by the stack map and the guides. No dependencies, nothing leaves the page.
(() => {
  'use strict';
  document.documentElement.classList.add('js');

  const dataEl = document.getElementById('stack-data');
  const data = dataEl ? JSON.parse(dataEl.textContent) : { tiers: {} };
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  // localStorage can be missing or blocked: everything works without it.
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(`stack-guide:${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`stack-guide:${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
  };

  // ---- Tier ----
  let tier = store.get('tier', 'standard');
  if (!data.tiers[tier]) tier = 'standard';

  const fmt = (n) => n.toLocaleString('en-US');

  function fact(name, plan, active) {
    if (name === 'services') return String(plan.services.length);
    if (name === 'ram') return (plan.totalMiB / 1024).toFixed(1);
    // Same count as routeCount in tools/lib/build.mjs: a route needs its Component, or is "always" there.
    if (name === 'routes') return String(data.routeComponents.filter((c) => c === 'always' || active.has(c)).length);
    return '';
  }

  function renderTierTable(el, plan) {
    const usable = data.usableMiB;
    const pct = Math.round((plan.totalMiB / usable) * 100);
    const over = plan.totalMiB > usable * data.budget;
    const bar = plan.services
      .filter((s) => s.memMiB)
      .map((s) => `<span class="seg" title="${s.name} ${fmt(s.memMiB)} MiB" style="width:${(s.memMiB / usable) * 100}%;background:var(--c-${s.group})"></span>`)
      .join('');
    const groups = [...new Set(plan.services.map((s) => s.group))];
    const key = groups.map((g) => `<span><i style="background:var(--c-${g})"></i>${g}</span>`).join('');
    const rows = plan.services
      .map((s) => `<tr><td><span class="gdot" style="background:var(--c-${s.group})"></span>${s.name}</td><td>${s.group}</td><td class="num">${s.memMiB ? fmt(s.memMiB) : '-'}</td><td class="num">${s.cpus ?? '-'}</td></tr>`)
      .join('');
    el.innerHTML = `
      <div class="capcard">
        <div class="capstats">
          <div><b>${plan.services.length}</b><span>containers in tier <code>${plan.name}</code></span></div>
          <div><b>${fmt(plan.totalMiB)} MiB</b><span>sum of the RAM limits</span></div>
          <div><b>${pct}%</b><span>of ${fmt(usable)} MiB (reference VM)</span></div>
        </div>
        <div class="capbar" aria-hidden="true">${bar}<span class="lim" style="left:${data.budget * 100}%"><span>${Math.round(data.budget * 100)}%</span></span></div>
        <div class="capkey">${key}</div>
        <p class="capnote${over ? ' warn' : ''}">${over
          ? `The limits are above ${Math.round(data.budget * 100)}% of the reference RAM: lower some limits or pick a smaller tier.`
          : `Within the ${Math.round(data.budget * 100)}% rule of thumb; the rest is for the OS, page cache and swap.`}</p>
      </div>
      <div class="tbl"><table>
        <thead><tr><th>Container</th><th>Group</th><th class="num">RAM cap (MiB)</th><th class="num">CPU cap</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  function applyTier() {
    const plan = { name: tier, ...data.tiers[tier] };
    const active = new Set(plan.services.map((s) => s.name));
    $$('.tier-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tier === tier)));
    $$('[data-component]').forEach((el) => el.classList.toggle('off', !el.dataset.component.split(' ').some((n) => active.has(n))));
    $$('[data-needs]').forEach((el) => el.classList.toggle('off', !el.dataset.needs.split(' ').every((n) => active.has(n))));
    updateProgress();
    $$('[data-fact]').forEach((el) => { el.textContent = fact(el.dataset.fact, plan, active); });
    $$('[data-generated="tier-table"]').forEach((el) => renderTierTable(el, plan));
    $$('[data-tier-name]').forEach((el) => { el.textContent = tier; });
  }

  $$('.tier-switch button').forEach((b) => b.addEventListener('click', () => {
    tier = b.dataset.tier;
    store.set('tier', tier);
    applyTier();
    route();
  }));

  // ---- Copy and download ----
  function flash(button, label) {
    const old = button.textContent;
    button.textContent = label;
    button.classList.add('ok');
    setTimeout(() => { button.textContent = old; button.classList.remove('ok'); }, 1400);
  }

  document.addEventListener('click', (event) => {
    const copy = event.target.closest('button.copy');
    if (copy) {
      const text = copy.closest('.code, .tpl').querySelector('pre').textContent;
      const done = () => flash(copy, 'Copied');
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => flash(copy, 'Press Ctrl+C'));
      else flash(copy, 'Press Ctrl+C');
      return;
    }
    const download = event.target.closest('button.download');
    if (download) {
      const text = download.closest('.tpl').querySelector('pre').textContent;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: download.dataset.filename });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
  });

  // ---- Step progress (the A → G checklist; nothing sensitive is stored) ----
  const steps = store.get('steps', {});
  const boxes = $$('.step-done');
  // Only steps the selected tier shows count: a hidden step can neither be done nor be missing.
  function updateProgress() {
    const shown = boxes.filter((c) => !c.closest('[data-needs].off'));
    const done = shown.filter((c) => c.checked).length;
    $$('[data-progress-count]').forEach((el) => { el.textContent = `${done} / ${shown.length}`; });
    const percent = shown.length ? Math.round((done / shown.length) * 100) : 0;
    $$('.prog i').forEach((bar) => { bar.style.width = `${percent}%`; });
    $$('[data-progress-percent]').forEach((el) => { el.textContent = `${percent}%`; });
    $$('.prog[role="progressbar"]').forEach((el) => el.setAttribute('aria-valuenow', String(percent)));
  }
  boxes.forEach((cb) => {
    cb.checked = Boolean(steps[cb.dataset.step]);
    cb.addEventListener('change', () => { steps[cb.dataset.step] = cb.checked; store.set('steps', steps); updateProgress(); });
  });
  $$('[data-progress-reset]').forEach((b) => b.addEventListener('click', () => {
    Object.keys(steps).forEach((k) => delete steps[k]);
    store.set('steps', steps);
    boxes.forEach((c) => { c.checked = false; });
    updateProgress();
  }));
  if (Object.keys(data.tiers).length) applyTier();
  updateProgress();

  // ---- Stack map: each component opens the guide step that sets it up; the hub's items (data-hub) open the hub's step ----
  if (!document.querySelector('.doc')) {
    const links = data.stepLinks || {};
    $$('[data-component], [data-hub]').forEach((el) => {
      const link = el.dataset.component ? links[el.dataset.component.split(' ')[0]] : data.hubLink;
      if (!link) return;
      const go = () => { location.href = link.href; };
      el.classList.add('linked');
      el.setAttribute('role', 'link');
      el.setAttribute('tabindex', '0');
      el.setAttribute('title', link.label ? `Set up in step ${link.label}` : 'Where it is set up');
      el.addEventListener('click', (event) => { if (!event.target.closest('a')) go(); });
      el.addEventListener('keydown', (event) => { if (event.key === 'Enter') go(); });
    });
  }

  // ---- Guides: one document panel at a time, chosen by the URL hash ----
  const panels = $$('.doc');
  function route() {
    if (!panels.length) return;
    const id = decodeURIComponent(location.hash.slice(1));
    const hidden = (el) => Boolean(el && el.closest('[data-needs].off'));
    const wanted = id ? document.getElementById(id) : null;
    // A document or section the selected tier does not run falls back to the first panel.
    const target = hidden(wanted) ? null : wanted;
    let panel = (target && target.closest('.doc')) || panels[0];
    if (hidden(panel.querySelector('h1'))) panel = panels[0];
    panels.forEach((p) => p.classList.toggle('active', p === panel));
    $$('nav.toc li[data-doc]').forEach((li) => li.classList.toggle('active', li.dataset.doc === panel.id));
    if (target && target !== panel) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  route();
})();
