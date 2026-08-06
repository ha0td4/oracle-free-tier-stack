#!/usr/bin/env node
// Usage: node tools/build-guide.mjs [--out dist] [--guide-path guide] [--plan-path plan] [--artifact]
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { build } from './lib/build.mjs';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'dist' },
    'guide-path': { type: 'string', default: 'guide' },
    'plan-path': { type: 'string', default: 'plan' },
    artifact: { type: 'boolean', default: false },
  },
});
const result = build({ rootUrl: new URL('../', import.meta.url), outDir: resolve(values.out), guidePath: values['guide-path'], planPath: values['plan-path'], artifact: values.artifact });
console.log(`Wrote ${result.files.join('\n      ')}`);
