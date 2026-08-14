import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FrameworkContractError } from '../../../../src/kernel/contract-validation.ts';
import {
  assertAgentPackageSkillProjection,
  materializeAgentPackageWorkspaceSkillProjection,
  refreshInstalledAgentPackageWorkspaceSkills,
  syncAgentPackageSkillProjectionToWorkspace,
} from '../../../../src/modules/connect/agent-package-registry-parts/skill-projection.ts';
import { hostAttemptSkillRuntime } from '../../../../src/modules/runway/family-runtime-attempt-skill-projection.ts';

function writeProfessionalSkill(root: string, skillId: string, body = `# ${skillId}\n`) {
  const skillRoot = path.join(root, 'agent', 'professional_skills', skillId);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), body);
}

function writeCapabilityMap(root: string, skillIds: string[]) {
  fs.mkdirSync(path.join(root, 'contracts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'contracts', 'capability_map.json'), `${JSON.stringify({
    surface_kind: 'opl_standard_agent_capability_map',
    capabilities: skillIds.map((skillId) => ({
      capability_id: skillId,
      surface_role: 'professional_skill',
      capability_kind: 'professional_skill',
      physical_source_ref: {
        ref_kind: 'repo_path',
        ref: `agent/professional_skills/${skillId}/SKILL.md`,
      },
    })),
  }, null, 2)}\n`);
}

function rootFixture(root: string, skillIds: string[]) {
  for (const skillId of skillIds) writeProfessionalSkill(root, skillId);
  writeCapabilityMap(root, skillIds);
}

function providerFixture(root: string, skillIds: string[]) {
  for (const skillId of skillIds) {
    const skillRoot = path.join(root, 'skills', skillId);
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `# ${skillId}\n`);
  }
}

function numberedSkills(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(2, '0')}`);
}

function removeFixture(root: string) {
  function makeWritable(candidate: string) {
    if (!fs.existsSync(candidate)) return;
    const stat = fs.lstatSync(candidate);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.chmodSync(candidate, 0o755);
      for (const entry of fs.readdirSync(candidate)) makeWritable(path.join(candidate, entry));
    } else if (!stat.isSymbolicLink()) {
      fs.chmodSync(candidate, 0o644);
    }
  }
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

test('installed Skill refresh consumes the Connect descriptor discovery service', () => {
  let discoveries = 0;
  const result = refreshInstalledAgentPackageWorkspaceSkills({
    packageId: 'future-agent',
    packageStatus: {
      installed_package_count: 1,
      launch_allowed: true,
    },
    descriptorDiscovery: {
      discover() {
        discoveries += 1;
        return new Map();
      },
    },
  });

  assert.equal(discoveries, 1);
  assert.equal(result.status, 'not_installed');
  assert.equal(result.reason, 'package_not_installed');
  assert.equal(result.writes_performed, false);
});

test('all five standard Agents project their complete professional Skill closure without primary Skills', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-standard-agent-skill-closure-'));
  const stateRoot = path.join(fixtureRoot, 'state');
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = stateRoot;

  try {
    const cases = [
      { packageId: 'mas', rootSkills: [], providerSkills: numberedSkills('mas-scholar', 34), expected: 34 },
      { packageId: 'mag', rootSkills: numberedSkills('mag-method', 2), providerSkills: [], expected: 2 },
      { packageId: 'rca', rootSkills: numberedSkills('rca-method', 8), providerSkills: [], expected: 8 },
      { packageId: 'oma', rootSkills: numberedSkills('oma-method', 4), providerSkills: [], expected: 4 },
      { packageId: 'obf', rootSkills: numberedSkills('obf-method', 5), providerSkills: [], expected: 5 },
    ] as const;

    for (const fixture of cases) {
      const agentRoot = path.join(fixtureRoot, fixture.packageId);
      rootFixture(agentRoot, [...fixture.rootSkills]);
      const providerRoot = path.join(fixtureRoot, `${fixture.packageId}-provider`);
      providerFixture(providerRoot, [...fixture.providerSkills]);
      const result = materializeAgentPackageWorkspaceSkillProjection({
        rootPackageId: fixture.packageId,
        rootSkillIds: [fixture.packageId],
        rootSourceRoot: agentRoot,
        rootSourceRef: `${fixture.packageId}:installed-descriptor`,
        providers: fixture.providerSkills.length > 0
          ? [{
              packageId: 'mas-scholar-skills',
              sourceRoot: providerRoot,
              sourceRef: 'mas-scholar-skills:installed-descriptor',
              exports: [
                { skillId: 'mas-scholar-skills', installMode: 'core_required' },
                ...fixture.providerSkills.map((skillId) => ({
                  skillId,
                  installMode: 'core_required' as const,
                })),
              ],
            }]
          : [],
      });

      assert.ok(result.projection, fixture.packageId);
      assert.equal(result.skill_ids.length, fixture.expected, fixture.packageId);
      assert.deepEqual(result.root_skill_ids, [fixture.packageId], fixture.packageId);
      assert.equal(result.skill_ids.includes(fixture.packageId), false, fixture.packageId);
      assert.equal(result.skill_ids.includes('mas-scholar-skills'), false, fixture.packageId);
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    removeFixture(fixtureRoot);
  }
});

test('Skill refresh creates a new immutable generation while an existing Attempt stays pinned', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-skill-generation-refresh-'));
  const stateRoot = path.join(fixtureRoot, 'state');
  const agentRoot = path.join(fixtureRoot, 'mag');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const skillId = 'mag-method';
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = stateRoot;
  fs.mkdirSync(workspaceRoot, { recursive: true });

  try {
    rootFixture(agentRoot, [skillId]);
    const first = materializeAgentPackageWorkspaceSkillProjection({
      rootPackageId: 'mag',
      rootSkillIds: ['mag'],
      rootSourceRoot: agentRoot,
      rootSourceRef: 'mag:installed-descriptor',
    });
    assert.ok(first.projection);
    assert.equal(
      syncAgentPackageSkillProjectionToWorkspace(first.projection, workspaceRoot).status,
      'materialized',
    );

    const unchanged = materializeAgentPackageWorkspaceSkillProjection({
      rootPackageId: 'mag',
      rootSkillIds: ['mag'],
      rootSourceRoot: agentRoot,
      rootSourceRef: 'mag:installed-descriptor',
    });
    assert.equal(unchanged.status, 'unchanged');
    assert.equal(unchanged.generation_id, first.generation_id);
    assert.equal(
      syncAgentPackageSkillProjectionToWorkspace(unchanged.projection!, workspaceRoot).status,
      'unchanged',
    );

    const oldAttemptRuntime = hostAttemptSkillRuntime({
      workspace_locator: {
        native_package_closure: { skill_projection: first.projection },
      },
    });
    assert.ok(oldAttemptRuntime);
    assert.equal(oldAttemptRuntime.env.HOME, first.projection.projection_root);

    writeProfessionalSkill(agentRoot, skillId, '# mag-method\n\nUpdated professional method.\n');
    const refreshed = materializeAgentPackageWorkspaceSkillProjection({
      rootPackageId: 'mag',
      rootSkillIds: ['mag'],
      rootSourceRoot: agentRoot,
      rootSourceRef: 'mag:installed-descriptor',
    });
    assert.ok(refreshed.projection);
    assert.notEqual(refreshed.generation_id, first.generation_id);
    assert.equal(assertAgentPackageSkillProjection(first.projection), first.projection);
    assert.equal(oldAttemptRuntime.env.HOME, first.projection.projection_root);

    syncAgentPackageSkillProjectionToWorkspace(refreshed.projection, workspaceRoot);
    assert.match(
      fs.readFileSync(path.join(workspaceRoot, '.codex', 'skills', skillId, 'SKILL.md'), 'utf8'),
      /Updated professional method/,
    );
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    removeFixture(fixtureRoot);
  }
});

test('Workspace projection refuses to overwrite an unmanaged Skill directory', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-skill-workspace-collision-'));
  const stateRoot = path.join(fixtureRoot, 'state');
  const agentRoot = path.join(fixtureRoot, 'oma');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const skillId = 'oma-method';
  const unmanagedRoot = path.join(workspaceRoot, '.codex', 'skills', skillId);
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = stateRoot;

  try {
    rootFixture(agentRoot, [skillId]);
    fs.mkdirSync(unmanagedRoot, { recursive: true });
    fs.writeFileSync(path.join(unmanagedRoot, 'SKILL.md'), '# User-owned method\n');
    const projection = materializeAgentPackageWorkspaceSkillProjection({
      rootPackageId: 'oma',
      rootSkillIds: ['oma'],
      rootSourceRoot: agentRoot,
      rootSourceRef: 'oma:installed-descriptor',
    }).projection!;

    assert.throws(
      () => syncAgentPackageSkillProjectionToWorkspace(projection, workspaceRoot),
      (error: unknown) => error instanceof FrameworkContractError
        && error.details?.failure_code === 'agent_package_workspace_skill_unowned_collision',
    );
    assert.equal(
      fs.readFileSync(path.join(unmanagedRoot, 'SKILL.md'), 'utf8'),
      '# User-owned method\n',
    );
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    removeFixture(fixtureRoot);
  }
});

test('Workspace projection refuses a .codex symlink before writing outside the Workspace', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-skill-workspace-symlink-'));
  const stateRoot = path.join(fixtureRoot, 'state');
  const agentRoot = path.join(fixtureRoot, 'oma');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const outsideCodex = path.join(fixtureRoot, 'outside-codex');
  const skillId = 'oma-method';
  const sentinelPath = path.join(outsideCodex, 'sentinel.txt');
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = stateRoot;

  try {
    rootFixture(agentRoot, [skillId]);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(outsideCodex, { recursive: true });
    fs.writeFileSync(sentinelPath, 'must remain untouched\n');
    fs.symlinkSync(outsideCodex, path.join(workspaceRoot, '.codex'), 'dir');
    const projection = materializeAgentPackageWorkspaceSkillProjection({
      rootPackageId: 'oma',
      rootSkillIds: ['oma'],
      rootSourceRoot: agentRoot,
      rootSourceRef: 'oma:installed-descriptor',
    }).projection!;

    assert.throws(
      () => syncAgentPackageSkillProjectionToWorkspace(projection, workspaceRoot),
      (error: unknown) => error instanceof FrameworkContractError
        && error.details?.failure_code === 'agent_package_workspace_skill_projection_path_invalid',
    );
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'must remain untouched\n');
    assert.equal(fs.existsSync(path.join(outsideCodex, 'skills')), false);
    assert.equal(fs.lstatSync(path.join(workspaceRoot, '.codex')).isSymbolicLink(), true);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    removeFixture(fixtureRoot);
  }
});

test('Workspace projection accepts an existing physical .codex directory', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-skill-workspace-physical-codex-'));
  const stateRoot = path.join(fixtureRoot, 'state');
  const agentRoot = path.join(fixtureRoot, 'mag');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const skillId = 'mag-method';
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = stateRoot;

  try {
    rootFixture(agentRoot, [skillId]);
    fs.mkdirSync(path.join(workspaceRoot, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    const projection = materializeAgentPackageWorkspaceSkillProjection({
      rootPackageId: 'mag',
      rootSkillIds: ['mag'],
      rootSourceRoot: agentRoot,
      rootSourceRef: 'mag:installed-descriptor',
    }).projection!;

    assert.equal(
      syncAgentPackageSkillProjectionToWorkspace(projection, workspaceRoot).status,
      'materialized',
    );
    assert.equal(
      fs.readFileSync(path.join(workspaceRoot, '.codex', 'skills', skillId, 'SKILL.md'), 'utf8'),
      `# ${skillId}\n`,
    );
    assert.equal(
      fs.readFileSync(path.join(workspaceRoot, '.codex', 'config.toml'), 'utf8'),
      'model = "gpt-5"\n',
    );
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    removeFixture(fixtureRoot);
  }
});
