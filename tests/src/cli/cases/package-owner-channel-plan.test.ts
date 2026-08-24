import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function fingerprint(version: string, content: string, commit: string) {
  return {
    package_version: version,
    package_content_digest: `sha256:${content.repeat(64)}`,
    owner_source_commit: commit.repeat(40),
  };
}

function runPlan(candidate: unknown, current: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-owner-channel-plan-'));
  const candidatePath = path.join(root, 'candidate.json');
  const currentPath = path.join(root, 'current.json');
  fs.writeFileSync(candidatePath, `${JSON.stringify({ candidate_fingerprint: candidate })}\n`);
  fs.writeFileSync(currentPath, `${JSON.stringify({ packages: current })}\n`);
  return JSON.parse(execFileSync(process.execPath, [
    'scripts/package-owner-channel-plan.mjs',
    '--candidate-summary', candidatePath,
    '--current-state', currentPath,
  ], { cwd: repoRoot, encoding: 'utf8' }));
}

test('owner-channel plan skips the same version and semantic content across a newer source commit', () => {
  const plan = runPlan(
    { 'opl-fleet-agent': fingerprint('0.2.41', 'a', 'b') },
    {
      'opl-fleet-agent': {
        status: 'present',
        digest: `sha256:${'c'.repeat(64)}`,
        fingerprint: fingerprint('0.2.41', 'a', 'd'),
      },
    },
  );
  assert.equal(plan.status, 'skipped');
  assert.equal(plan.publish_required, false);
  assert.deepEqual(plan.changed_packages, []);
  assert.deepEqual(plan.unchanged_packages, ['opl-fleet-agent']);
});

test('owner-channel plan publishes only a new version with changed semantic content', () => {
  const plan = runPlan(
    { mas: fingerprint('0.2.28', 'a', 'b') },
    {
      mas: {
        status: 'present',
        digest: `sha256:${'c'.repeat(64)}`,
        fingerprint: fingerprint('0.2.27', 'd', 'e'),
      },
    },
  );
  assert.equal(plan.status, 'publish_required');
  assert.equal(plan.publish_required, true);
  assert.deepEqual(plan.changed_packages, ['mas']);
});

test('owner-channel plan bootstraps a verified absent Package channel', () => {
  const plan = runPlan(
    { rca: fingerprint('0.2.15', 'a', 'b') },
    { rca: { status: 'absent', digest: null, fingerprint: null } },
  );
  assert.equal(plan.publish_required, true);
  assert.deepEqual(plan.changed_packages, ['rca']);
});

test('owner-channel plan requires a version bump when semantic content changes in place', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-owner-channel-plan-'));
  const candidatePath = path.join(root, 'candidate.json');
  const currentPath = path.join(root, 'current.json');
  fs.writeFileSync(candidatePath, `${JSON.stringify({
    candidate_fingerprint: { 'opl-fleet-agent': fingerprint('0.2.41', 'a', 'b') },
  })}\n`);
  fs.writeFileSync(currentPath, `${JSON.stringify({
    packages: {
      'opl-fleet-agent': {
        status: 'present',
        digest: `sha256:${'c'.repeat(64)}`,
        fingerprint: fingerprint('0.2.41', 'd', 'e'),
      },
    },
  })}\n`);
  const result = spawnSync(process.execPath, [
    'scripts/package-owner-channel-plan.mjs',
    '--candidate-summary', candidatePath,
    '--current-state', currentPath,
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 2);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.violations[0].reason, 'version_bump_required');
});

test('owner-channel plan rejects a version-only publication', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-owner-channel-plan-'));
  const candidatePath = path.join(root, 'candidate.json');
  const currentPath = path.join(root, 'current.json');
  fs.writeFileSync(candidatePath, `${JSON.stringify({
    candidate_fingerprint: { oma: fingerprint('0.4.10', 'a', 'b') },
  })}\n`);
  fs.writeFileSync(currentPath, `${JSON.stringify({
    packages: {
      oma: {
        status: 'present',
        digest: `sha256:${'c'.repeat(64)}`,
        fingerprint: fingerprint('0.4.9', 'a', 'd'),
      },
    },
  })}\n`);
  const result = spawnSync(process.execPath, [
    'scripts/package-owner-channel-plan.mjs',
    '--candidate-summary', candidatePath,
    '--current-state', currentPath,
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).violations[0].reason, 'version_change_without_content_change');
});
