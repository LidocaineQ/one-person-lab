#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: 'string' },
    format: { type: 'string', default: 'json' },
    help: { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write([
    'Usage: node scripts/source-module-public-imports.mjs [options]',
    '',
    'Read-only compatibility entry for the unified source-unit boundary checker.',
    '',
    'Options:',
    '  --root <path>   Repo root to inspect.',
    '  --format json   Machine-readable output format.',
    '  --help          Print this help.',
    '',
  ].join('\n'));
  process.exit(0);
}
if (values.format !== 'json') {
  process.stderr.write('source module public imports: --format must be json\n');
  process.exit(1);
}

const root = path.resolve(values.root ?? defaultRoot);
const checker = path.join(defaultRoot, 'scripts/source-module-boundary.mjs');
const result = spawnSync(process.execPath, [
  checker,
  '--root', root,
  '--strict-imports',
  '--strict-cycles',
  '--format', 'json',
], { cwd: root, encoding: 'utf8' });
if (result.stderr) process.stderr.write(result.stderr);
if (!result.stdout.trim()) process.exit(result.status ?? 1);

const boundary = JSON.parse(result.stdout);
const summary = {
  status: boundary.status,
  mode: 'read_only_source_unit_boundary',
  source_unit_count: boundary.source_units?.length ?? 0,
  source_files_scanned: boundary.cross_module_imports?.policy?.source_files_scanned ?? 0,
  deep_imports_seen: boundary.cross_module_imports?.deep_import_violations?.count ?? null,
  forbidden_layer_edges: boundary.cross_module_imports?.forbidden_dependency_violations?.count ?? null,
  dependency_cycles: boundary.cross_module_imports?.dependency_cycles?.count ?? null,
  changed_files: [],
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(result.status ?? 1);
