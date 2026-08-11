import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildSourceStructureOperatorReadback } from '../../src/modules/charter/source-structure-operator-readback.ts';

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
  const root = fs.mkdtempSync(path.join(process.env.OPL_REPO_TEMP_ROOT || os.tmpdir(), 'opl-source-structure-'));
  const contractPath = path.join(root, 'contracts', 'opl-framework', 'source-structure-budget.json');
  const contract = input.contract ?? {
    contract_kind: 'opl_source_structure_budget.v1',
    surface_kind: 'opl_source_structure_budget',
    owner: 'one-person-lab',
    state: 'active_contract',
    default_limit: input.defaultLimit ?? 3,
    advisory_near_limit: input.defaultLimit ?? 3,
    baseline_policy: {
      mode: 'advisory_inventory_only',
      default_developer_behavior: 'findings_exit_zero',
      compatibility_entrypoints: ['npm run line-budget:strict'],
    },
    reviewed_baselines: [],
  };

  const init = spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (const [relativePath, lines] of Object.entries(input.files)) {
    writeLines(path.join(root, relativePath), lines);
  }
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  const add = spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);

  return { root, contractPath };
}

test('source structure readback keeps legacy strict requests advisory', () => {
  const { root, contractPath } = fixture({
    files: {
      'src/new-large-entry.ts': 4,
      'src/near-limit-entry.ts': 3,
    },
    defaultLimit: 3,
  });

  try {
    const readback = buildSourceStructureOperatorReadback({
      repoRoot: root,
      contractPath,
      strict: true,
    }).source_structure_operator_readback;

    assert.equal(readback.surface_kind, 'opl_source_structure_operator_readback');
    assert.equal(readback.mode, 'strict_readback');
    assert.equal(readback.enforcement_mode, 'advisory_only');
    assert.equal(readback.strict_requested, true);
    assert.equal(readback.default_limit, 3);
    assert.equal(readback.oversized_file_count, 1);
    assert.equal(readback.near_limit_file_count, 1);
    assert.equal(readback.reviewed_baseline_count, 0);
    assert.equal(readback.strict_ratchet_passed, true);
    assert.equal(readback.strict_blocking_finding_count, 0);
    assert.equal(readback.findings[0].finding_kind, 'oversized_file');
    assert.equal(readback.findings[0].strict_blocks, false);
    assert.equal(readback.oversized_files[0].reviewed_baseline_status, 'not_applicable');
    assert.equal(readback.advisory_passed, true);
    assert.equal(readback.authority_boundary.can_claim_domain_ready, false);
    assert.equal(readback.false_ready_guard.findings_are_maintenance_signal_not_domain_blocker, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retired per-file baseline metadata is reported but never blocks', () => {
  const { root, contractPath } = fixture({
    files: { 'src/legacy-entry.ts': 4 },
    defaultLimit: 3,
    contract: {
      contract_kind: 'opl_source_structure_budget.v1',
      surface_kind: 'opl_source_structure_budget',
      default_limit: 3,
      advisory_near_limit: 3,
      baseline_policy: { mode: 'advisory_inventory_only' },
      reviewed_baselines: [{ path: 'src/legacy-entry.ts', limit: 4 }],
    },
  });

  try {
    const readback = buildSourceStructureOperatorReadback({ repoRoot: root, contractPath })
      .source_structure_operator_readback;

    assert.equal(readback.strict_blocking_finding_count, 0);
    assert.equal(readback.strict_ratchet_passed, true);
    assert.ok(readback.findings.some((finding) =>
      finding.finding_kind === 'contract_invalid'
      && finding.message.includes('reviewed_baselines is retired')
      && finding.strict_blocks === false));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
