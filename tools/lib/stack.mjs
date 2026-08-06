// Parsers for docker-compose.yml and tiers/*.env: the numbers the guide shows come from the real files.

const UNITS = { k: 1 / 1024, m: 1, g: 1024 };

export function parseMem(value) {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg])?b?$/i.exec(String(value).trim());
  if (!m) throw new Error(`Unsupported memory value: ${value}`);
  return Math.round(Number(m[1]) * UNITS[(m[2] ?? 'm').toLowerCase()]);
}

// Line scanner for the compose layout used in this repo (2-space services, 4-space properties).
export function parseCompose(text) {
  const services = [];
  let section = null;
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const top = /^([A-Za-z0-9_-]+):/.exec(line);
    if (top) { section = top[1]; cur = null; continue; }
    if (section !== 'services') continue;
    const head = /^ {2}([a-z0-9][a-z0-9_-]*):\s*$/.exec(line);
    if (head) {
      cur = { name: head[1], profiles: [], memVar: null, memDefault: null, cpusVar: null, cpusDefault: null };
      services.push(cur);
      continue;
    }
    if (!cur) continue;
    const profiles = /^ {4}profiles:\s*\[(.*?)\]/.exec(line);
    if (profiles) cur.profiles = profiles[1].split(',').map((s) => s.trim()).filter(Boolean);
    const mem = /^ {4}mem_limit:\s*([^#]+?)\s*(?:#.*)?$/.exec(line);
    if (mem) {
      const v = /^\$\{(\w+):-([^}]+)\}$/.exec(mem[1]);
      cur.memVar = v ? v[1] : null;
      cur.memDefault = parseMem(v ? v[2] : mem[1]);
    }
    const cpus = /^ {4}cpus:\s*([^#]+?)\s*(?:#.*)?$/.exec(line);
    if (cpus) {
      const v = /^\$\{(\w+):-([^}]+)\}$/.exec(cpus[1]);
      cur.cpusVar = v ? v[1] : null;
      cur.cpusDefault = Number(v ? v[2] : cpus[1]);
    }
  }
  return services;
}

export function parseTierEnv(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) vars[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^"|"$/g, '');
  }
  const profiles = (vars.COMPOSE_PROFILES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { profiles, vars };
}

// Services that run for a tier (no profile = always on) and their RAM limits.
export function planTier(services, tier) {
  const active = services.filter((s) => s.profiles.length === 0 || s.profiles.some((p) => tier.profiles.includes(p)));
  const planned = active.map((s) => {
    const override = s.memVar && tier.vars[s.memVar];
    const cpus = s.cpusVar && tier.vars[s.cpusVar];
    return {
      name: s.name,
      profiles: s.profiles,
      memMiB: override ? parseMem(override) : s.memDefault,
      cpus: cpus ? Number(cpus) : s.cpusDefault,
    };
  });
  return { services: planned, totalMiB: planned.reduce((sum, s) => sum + (s.memMiB ?? 0), 0) };
}
