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
const scriptPath = path.join(repoRoot, 'scripts', 'refactor-patrol-state.mjs');

function candidate() {
  return {
    id: 'candidate-1',
    repo: 'one-person-lab',
    truth_owner: 'one-person-lab',
    owner_surface: 'src/example.ts',
    candidate: 'shrink duplicate helper family',
    tag: 'shrink',
    route: 'refactor_patrol',
    active_caller_evidence: 'CodeGraph callers read back',
    authority_blocker: null,
    allowed_write_set: ['src/example.ts'],
    forbidden_write_set: ['contracts/domain-truth/**'],
    risk_class: 'medium',
    verification_command: 'npm test',
    estimated_complexity_reduction: 'one duplicate implementation removed',
    status: 'selected',
    selected_or_skipped_reason: 'highest-value executable package',
  };
}

function validState() {
  return {
    schema: 'opl_reasonable_refactor_patrol_state.v1',
    snapshot: {
      captured_at: '2026-08-04T00:00:00Z',
      source_refs: { 'one-person-lab': 'abc123' },
    },
    issue_library: [candidate()],
    work_packages: [{
      package_id: 'package-1',
      child_candidate_ids: ['candidate-1'],
      repo: 'one-person-lab',
      semantic_boundary: 'example helper family',
      expected_complexity_reduction: 'one duplicate implementation removed',
      verification_fan_in: ['npm test'],
      allowed_write_set: ['src/example.ts'],
      forbidden_write_set: ['contracts/domain-truth/**'],
      package_acceptance_gate: 'canonical main and remote readback',
    }],
    selected_package_ids: ['package-1'],
    burn_down: [{
      package_id: 'package-1',
      status: 'done',
      evidence: ['tests passed', 'canonical main read back'],
      commit_or_reason: 'abc123',
      next_action: 'closed',
    }],
    run_status: 'completed',
    remaining: [] as string[],
  };
}

function run(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('refactor patrol policy contract rejects fixed orchestration quotas', () => {
  const result = run(['contract']);
  assert.equal(result.status, 0, result.stderr);
  const output = parseJsonText(result.stdout) as any;
  assert.equal(output.status, 'ok');
  assert.deepEqual(output.errors, []);
});

test('refactor patrol state accepts a coherent terminal selected batch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-refactor-patrol-state-'));
  try {
    const input = path.join(root, 'state.json');
    fs.writeFileSync(input, `${JSON.stringify(validState(), null, 2)}\n`);
    const result = run(['validate', '--input', input]);
    assert.equal(result.status, 0, result.stderr);
    const output = parseJsonText(result.stdout) as any;
    assert.equal(output.status, 'ok');
    assert.deepEqual(output.counts, {
      candidates: 1,
      work_packages: 1,
      selected_packages: 1,
      burn_down: 1,
      remaining: 0,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refactor patrol state rejects missing burn-down and false completed status', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-refactor-patrol-state-'));
  try {
    const input = path.join(root, 'state.json');
    const state = validState();
    state.burn_down = [];
    fs.writeFileSync(input, `${JSON.stringify(state, null, 2)}\n`);
    const result = run(['validate', '--input', input]);
    assert.equal(result.status, 1, result.stderr);
    const output = parseJsonText(result.stdout) as any;
    assert.equal(output.status, 'invalid');
    assert.ok(output.errors.includes('selected package has no burn-down entry: package-1'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refactor patrol state rejects terminal runs with remaining work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-refactor-patrol-state-'));
  try {
    const input = path.join(root, 'state.json');
    const state = validState();
    state.remaining = ['package-1 canonical absorption'];
    fs.writeFileSync(input, `${JSON.stringify(state, null, 2)}\n`);
    const result = run(['validate', '--input', input]);
    assert.equal(result.status, 1, result.stderr);
    const output = parseJsonText(result.stdout) as any;
    assert.equal(output.status, 'invalid');
    assert.ok(output.errors.includes('completed run must have remaining=[]'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
