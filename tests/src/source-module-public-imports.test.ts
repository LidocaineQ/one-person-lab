import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseJsonText } from '../../src/kernel/json-file.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'source-module-public-imports.mjs');

test('source module public imports is a read-only alias for the source-unit boundary', () => {
  const help = spawnSync(process.execPath, [scriptPath, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const json = spawnSync(process.execPath, [
    scriptPath,
    '--format',
    'json',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const output = parseJsonText(json.stdout) as any;

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: node scripts\/source-module-public-imports\.mjs/);
  assert.match(help.stdout, /--format json/);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(output.status, 'ok');
  assert.equal(output.mode, 'read_only_source_unit_boundary');
  assert.equal(output.source_unit_count, 13);
  assert.ok(output.source_files_scanned > 0);
  assert.equal(output.deep_imports_seen, 0);
  assert.equal(output.forbidden_layer_edges, 0);
  assert.equal(output.dependency_cycles, 0);
  assert.deepEqual(output.changed_files, []);
});
