import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseJsonText } from '../../src/kernel/json-file.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'line-budget.mjs');

function writeLines(file: string, lineCount: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Array.from({ length: lineCount }, (_, index) => `export const value${index} = ${index};`).join('\n') + '\n',
  );
}

function fixture(input: {
  files: Record<string, number>;
  defaultLimit?: number;
  contract?: Record<string, unknown>;
}) {
  const root = fs.mkdtempSync(path.join(process.env.OPL_REPO_TEMP_ROOT || os.tmpdir(), 'opl-line-budget-'));
  const contractPath = path.join(root, 'line-budget.contract.json');
  const contract = input.contract ?? {
    contract_kind: 'opl_source_structure_budget.v1',
    owner: 'one-person-lab',
    state: 'active_contract',
    default_limit: input.defaultLimit ?? 3,
    advisory_near_limit: input.defaultLimit ?? 3,
    baseline_policy: {
      mode: 'advisory_inventory_only',
    },
    reviewed_baselines: [],
  };

  const init = spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (const [relativePath, lines] of Object.entries(input.files)) {
    writeLines(path.join(root, relativePath), lines);
  }
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  const add = spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);

  return { root, contractPath };
}

function runLineBudget(
  root: string,
  contractPath: string,
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync(
    process.execPath,
    [scriptPath, '--root', root, '--baseline', contractPath, ...extraArgs],
    { cwd: repoRoot, encoding: 'utf8', env },
  );
}

test('line budget exposes advisory machine output without failure semantics', () => {
  const { root, contractPath } = fixture({
    files: { 'src/new-large-entry.ts': 4 },
    defaultLimit: 3,
  });

  try {
    const help = spawnSync(process.execPath, [scriptPath, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const result = runLineBudget(root, contractPath, ['--format', 'json']);
    const output = parseJsonText(result.stdout) as any;

    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Legacy compatibility alias; findings remain advisory/);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.surface_kind, 'opl_line_budget_check');
    assert.equal(output.status, 'advisory');
    assert.equal(output.enforcement, 'advisory_only');
    assert.equal(output.strict, false);
    assert.equal(output.oversize_count, 1);
    assert.equal(output.finding_count, 1);
    assert.equal(output.failure_count, 0);
    assert.deepEqual(output.failures, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('oversized files remain advisory in normal legacy strict and strict-env modes', () => {
  const { root, contractPath } = fixture({
    files: { 'src/legacy-entry.ts': 5 },
    defaultLimit: 3,
  });

  try {
    const normal = runLineBudget(root, contractPath);
    const legacyStrict = runLineBudget(root, contractPath, ['--strict', '--format', 'json']);
    const strictEnv = runLineBudget(root, contractPath, ['--format', 'json'], {
      ...process.env,
      OPL_LINE_BUDGET_STRICT: '1',
    });
    const legacyOutput = parseJsonText(legacyStrict.stdout) as any;
    const envOutput = parseJsonText(strictEnv.stdout) as any;

    assert.equal(normal.status, 0, normal.stderr);
    assert.match(normal.stderr, /line budget advisory/);
    assert.match(normal.stderr, /split only when a natural boundary exists/);
    assert.equal(legacyStrict.status, 0, legacyStrict.stderr);
    assert.equal(strictEnv.status, 0, strictEnv.stderr);
    assert.equal(legacyOutput.strict_requested, true);
    assert.equal(envOutput.strict_requested, true);
    assert.equal(legacyOutput.failure_count, 0);
    assert.equal(envOutput.failure_count, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid structure contracts are reported as advisory diagnostics', () => {
  const { root, contractPath } = fixture({
    files: { 'src/new-large-entry.ts': 4 },
    contract: {
      contract_kind: 'unexpected',
      default_limit: 0,
      baseline_policy: { mode: 'ratchet_no_growth' },
    },
  });

  try {
    const result = runLineBudget(root, contractPath, ['--strict', '--format', 'json']);
    const output = parseJsonText(result.stdout) as any;

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.enforcement, 'advisory_only');
    assert.equal(output.failure_count, 0);
    assert.ok(output.findings.some((finding: string) => finding.includes('contract_kind')));
    assert.ok(output.findings.some((finding: string) => finding.includes('advisory_inventory_only')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('line budget list remains a descending maintenance inventory', () => {
  const { root, contractPath } = fixture({
    files: {
      'src/medium.ts': 4,
      'src/largest.ts': 6,
      'src/small.ts': 2,
    },
    defaultLimit: 3,
  });

  try {
    const result = runLineBudget(root, contractPath, ['--list']);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n').map((line) => line.trim()), [
      '6 src/largest.ts',
      '4 src/medium.ts',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
