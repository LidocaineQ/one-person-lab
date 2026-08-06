import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  dependencyReadiness,
  requiredDependents,
} from '../../src/modules/connect/agent-package-registry-parts/dependency-closure.ts';
import {
  materializeAgentPackageSkillProjection,
} from '../../src/modules/connect/agent-package-registry-parts/skill-projection.ts';
import {
  assertInstalledPackagePluginSource,
  installedPackagePluginSourcePath,
} from '../../src/modules/connect/agent-package-registry-parts/installed-plugin-source.ts';
import { hostAttemptSkillRuntime } from '../../src/modules/runway/family-runtime-attempt-skill-projection.ts';
import { createFakeCodexFixture } from './cli/helpers.ts';
import { runPublicCodexStageRunner } from './family-runtime-codex-stage-runner-helpers.ts';
import type {
  AgentPackageLock,
  AgentPackageLockIndex,
  AgentPackageSourceKind,
} from '../../src/modules/connect/agent-package-registry-parts/types.ts';

test('optional enhancement provider failures stay diagnostic while hard dependencies remain closed', () => {
  const dependency = {
    package_id: 'fixture.optional-provider',
    required: false,
    dependency_kind: 'optional_enhancement',
    version_requirement: '>=1.0.0 <2.0.0',
    capability_abi: 'fixture.optional.v1',
    consumer_profile_id: null,
    required_export_ids: ['optional-core'],
    required_module_ids: ['optional.module'],
    bootstrap_manifest_url: null,
    dependency_source: null,
  } as const;
  const consumer = {
    package_id: 'fixture.consumer',
    agent_id: 'fixture.consumer',
    capability_dependencies: [dependency],
    resolved_dependencies: [],
  } as unknown as AgentPackageLock;
  const index = (packages: AgentPackageLock[]) => ({
    surface_kind: 'opl_agent_package_lock_index' as const,
    version: 'opl-agent-package-lock-index.v1' as const,
    packages,
  }) satisfies AgentPackageLockIndex;

  const missing = dependencyReadiness(consumer, index([consumer]));
  assert.equal(missing.status, 'missing');
  assert.equal(missing.operational_ready, true);
  assert.equal(missing.dependencies[0].required, false);

  const compatibleProvider = {
    package_id: dependency.package_id,
    package_version: '1.0.0',
    manifest_sha256: 'a'.repeat(64),
    content_digest: `sha256:${'b'.repeat(64)}`,
    lock_ref: 'opl://fixture/optional-provider',
    capability_provider: {
      capability_abi: dependency.capability_abi,
      exports: [{
        export_id: 'optional-core',
        skill_id: 'optional-core',
        install_mode: 'core_required',
      }],
      module_export_ids: ['optional.module'],
      consumer_profiles: [],
    },
  } as unknown as AgentPackageLock;
  const disabled = dependencyReadiness(consumer, index([
    consumer,
    { ...compatibleProvider, exposure_state: 'disabled' },
  ]));
  assert.equal(disabled.status, 'incompatible');
  assert.equal(disabled.operational_ready, true);
  assert.ok(disabled.dependencies[0].reasons.includes('dependency_disabled'));

  const incompatible = dependencyReadiness(consumer, index([
    consumer,
    {
      ...compatibleProvider,
      capability_provider: {
        ...compatibleProvider.capability_provider!,
        capability_abi: 'fixture.optional.v2',
      },
    },
  ]));
  assert.equal(incompatible.status, 'current');
  assert.equal(incompatible.operational_ready, true);
  assert.ok(!incompatible.dependencies[0].reasons.includes('capability_abi_mismatch'));
  assert.deepEqual(requiredDependents(index([consumer, compatibleProvider]), dependency.package_id), []);

  const hardConsumer = {
    ...consumer,
    capability_dependencies: [{
      ...dependency,
      required: true,
      dependency_kind: 'hard_runtime_dependency',
    }],
  } as unknown as AgentPackageLock;
  const hardMissing = dependencyReadiness(hardConsumer, index([hardConsumer]));
  assert.equal(hardMissing.status, 'missing');
  assert.equal(hardMissing.operational_ready, false);
  assert.deepEqual(
    requiredDependents(index([hardConsumer, compatibleProvider]), dependency.package_id),
    ['fixture.consumer'],
  );
});

function makeTreeWritable(root: string) {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isDirectory()) {
    fs.chmodSync(root, 0o755);
    for (const entry of fs.readdirSync(root)) makeTreeWritable(path.join(root, entry));
  } else if (!stat.isSymbolicLink()) {
    fs.chmodSync(root, 0o644);
  }
}

test('installed package source selection is cache-first for every source kind and legacy-compatible', () => {
  const sourceKinds: AgentPackageSourceKind[] = [
    'first_party_managed_cohort',
    'bundled_full_runtime_modules',
    'local_manifest_file',
    'manifest_url',
    'manifest_import',
    'developer_checkout_override',
  ];
  for (const sourceKind of sourceKinds) {
    const lock = {
      source_kind: sourceKind,
      physical_surface: {
        plugin_source_path: `/tmp/${sourceKind}-transient`,
        codex_plugin_cache_path: `/cache/${sourceKind}-immutable`,
      },
    } as unknown as AgentPackageLock;
    assert.equal(
      installedPackagePluginSourcePath(lock),
      `/cache/${sourceKind}-immutable`,
      sourceKind,
    );
    lock.physical_surface!.codex_plugin_cache_path = null;
    assert.equal(
      installedPackagePluginSourcePath(lock),
      `/tmp/${sourceKind}-transient`,
      `${sourceKind} legacy lock`,
    );
  }
});

test('installed package cache selection rejects paths outside the managed Codex cache', () => {
  const outsideCache = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-outside-cache-'));
  try {
    assert.throws(() => assertInstalledPackagePluginSource({
      package_id: 'fixture-outside-cache',
      source_kind: 'first_party_managed_cohort',
      physical_surface: {
        plugin_source_path: outsideCache,
        codex_plugin_cache_path: outsideCache,
      },
    } as unknown as AgentPackageLock), (error: any) =>
      error?.details?.failure_code === 'agent_package_persisted_path_unsafe');
  } finally {
    fs.rmSync(outsideCache, { recursive: true, force: true });
  }
});

test('package use materializes one immutable root and specialist Skill generation for Codex', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-skill-projection-'));
  const stateRoot = path.join(fixtureRoot, 'state');
  const codexHome = path.join(fixtureRoot, 'real-codex-home');
  const pluginCacheRoot = path.join(codexHome, 'plugins', 'cache');
  const rootPlugin = path.join(pluginCacheRoot, 'fixture-root', 'fixture-agent', 'generation-one');
  const providerPlugin = path.join(pluginCacheRoot, 'fixture-provider', 'fixture-provider', 'generation-one');
  const previousStateDir = process.env.OPL_STATE_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousHome = process.env.HOME;
  try {
    for (const [pluginRoot, skillId, body] of [
      [rootPlugin, 'fixture-agent', 'Root agent generation one.'],
      [providerPlugin, 'fixture-core', 'Core capability generation one.'],
      [providerPlugin, 'fixture-specialty', 'Specialty generation one.'],
    ]) {
      const skillRoot = path.join(pluginRoot, 'skills', skillId);
      fs.mkdirSync(skillRoot, { recursive: true });
      fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
        '---',
        `name: ${skillId}`,
        `description: ${body}`,
        '---',
        '',
        body,
        '',
      ].join('\n'));
    }
    process.env.OPL_STATE_DIR = stateRoot;
    process.env.HOME = path.join(fixtureRoot, 'real-home');
    process.env.CODEX_HOME = codexHome;
    const rootLock = {
      package_id: 'fixture-agent-package',
      lock_ref: 'opl://agent-package/fixture-agent-package/generation-one',
      source_kind: 'first_party_managed_cohort',
      bundled_required_skill_ids: ['fixture-agent'],
      physical_surface: {
        plugin_source_path: path.join(fixtureRoot, 'removed-root-source'),
        codex_plugin_cache_path: rootPlugin,
      },
    } as unknown as AgentPackageLock;
    const providerLock = {
      package_id: 'fixture-provider-package',
      lock_ref: 'opl://agent-package/fixture-provider-package/generation-one',
      source_kind: 'first_party_managed_cohort',
      physical_surface: {
        plugin_source_path: path.join(fixtureRoot, 'removed-provider-source'),
        codex_plugin_cache_path: providerPlugin,
      },
      capability_provider: {
        exports: [
          { skill_id: 'fixture-core', install_mode: 'core_required' },
          { skill_id: 'fixture-specialty', install_mode: 'optional_named_specialty' },
        ],
      },
    } as unknown as AgentPackageLock;
    const plannedProjection = materializeAgentPackageSkillProjection({
      root: rootLock,
      providers: [providerLock],
      dryRun: true,
    });
    assert.ok(plannedProjection);
    assert.equal(plannedProjection.status, 'planned_no_write');
    assert.equal(fs.existsSync(stateRoot), false);

    const projection = materializeAgentPackageSkillProjection({
      root: rootLock,
      providers: [providerLock],
      dryRun: false,
    });
    assert.ok(projection);
    assert.equal(projection.status, 'materialized');
    assert.deepEqual(projection.root_skill_ids, ['fixture-agent']);
    assert.deepEqual(projection.core_skill_ids, ['fixture-agent', 'fixture-core']);
    assert.deepEqual(projection.specialty_skill_ids, ['fixture-specialty']);
    assert.deepEqual(projection.skill_ids, ['fixture-agent', 'fixture-core', 'fixture-specialty']);
    assert.match(projection.core_digest, /^sha256:[a-f0-9]{64}$/);
    assert.match(projection.full_export_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      fs.readFileSync(path.join(projection.skills_root, 'fixture-agent', 'SKILL.md'), 'utf8').includes('generation one'),
      true,
    );
    assert.equal(fs.statSync(projection.projection_root).mode & 0o222, 0);
    assert.equal(fs.statSync(path.join(projection.skills_root, 'fixture-agent', 'SKILL.md')).mode & 0o222, 0);

    fs.writeFileSync(
      path.join(rootPlugin, 'skills', 'fixture-agent', 'SKILL.md'),
      '---\nname: fixture-agent\ndescription: Changed later.\n---\nChanged later.\n',
    );
    assert.equal(
      fs.readFileSync(path.join(projection.skills_root, 'fixture-agent', 'SKILL.md'), 'utf8').includes('generation one'),
      true,
    );

    const runtime = hostAttemptSkillRuntime({
      workspace_locator: {
        package_use_binding: { skill_projection: projection },
      },
    });
    assert.ok(runtime);
    assert.equal(runtime.env.HOME, projection.projection_root);
    assert.equal(runtime.env.CODEX_HOME, process.env.CODEX_HOME);
    assert.equal(runtime.shellHome, process.env.HOME);
    assert.deepEqual(
      runtime.packageSkillBindings.map((entry) => entry.name),
      projection.skill_ids,
    );
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    makeTreeWritable(fixtureRoot);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('hosted Codex Attempt reads the bound Skill generation without replacing the user Codex home', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-skill-hosted-attempt-'));
  const sourceRoot = path.join(fixtureRoot, 'plugin');
  const stateRoot = path.join(fixtureRoot, 'state');
  const invocationLog = path.join(fixtureRoot, 'invocation.log');
  const skillRoot = path.join(sourceRoot, 'skills', 'fixture-hosted-agent');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
    '---',
    'name: fixture-hosted-agent',
    'description: Use for the hosted package Skill projection fixture.',
    '---',
    '',
    'Use the immutable hosted fixture instructions.',
    '',
  ].join('\n'));
  const closeout = JSON.stringify({
    surface_kind: 'stage_attempt_closeout_packet',
    stage_attempt_id: 'sat-package-skill-projection',
    closeout_refs: ['artifact:fixture'],
    consumed_refs: ['packet:fixture'],
    consumed_memory_refs: [],
    writeback_receipt_refs: [],
    rejected_writes: [],
    next_owner: null,
    domain_ready_verdict: null,
    authority_boundary: { opl: 'transport_only', domain: 'fixture_owner' },
  });
  const script = [
    `printf 'HOME=%s\\nCODEX_HOME=%s\\nARGS=%s\\n' "$HOME" "$CODEX_HOME" "$*" > ${JSON.stringify(invocationLog)}`,
    'printf \'{"type":"thread.started","thread_id":"thread-package-skill"}\\n\'',
    `printf '%s\\n' ${JSON.stringify(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', id: 'message-package-skill', text: closeout },
    }))}`,
    'printf \'{"type":"turn.completed"}\\n\'',
  ].join('\n');
  const fakeCodex = createFakeCodexFixture(script);
  const previousStateDir = process.env.OPL_STATE_DIR;
  const previousCodexBin = process.env.OPL_CODEX_BIN;
  const previousSandbox = process.env.OPL_CODEX_STAGE_SANDBOX_PROVIDER;
  try {
    process.env.OPL_STATE_DIR = stateRoot;
    process.env.OPL_CODEX_BIN = fakeCodex.codexPath;
    process.env.OPL_CODEX_STAGE_SANDBOX_PROVIDER = 'host';
    const lock = {
      package_id: 'fixture-hosted-package',
      lock_ref: 'opl://agent-package/fixture-hosted-package/generation-one',
      source_kind: 'first_party_managed_cohort',
      bundled_required_skill_ids: ['fixture-hosted-agent'],
      physical_surface: { plugin_source_path: sourceRoot },
    } as unknown as AgentPackageLock;
    const projection = materializeAgentPackageSkillProjection({
      root: lock,
      providers: [],
      dryRun: false,
    });
    assert.ok(projection);
    const expectedCodexHome = process.env.CODEX_HOME?.trim()
      || path.join(process.env.HOME?.trim() || os.homedir(), '.codex');
    const receipt = await runPublicCodexStageRunner({
      attempt: {
        stage_attempt_id: 'sat-package-skill-projection',
        stage_id: 'fixture-stage',
        executor_kind: 'codex_cli',
        workspace_locator: {
          workspace_root: fakeCodex.fixtureRoot,
          package_use_binding: { skill_projection: projection },
        },
        checkpoint_refs: ['packet:fixture'],
      },
      runnerMode: 'codex_cli',
      timeoutMs: 10_000,
      env: { OPL_CODEX_STAGE_SANDBOX_PROVIDER: 'host' },
    });
    assert.equal(receipt.closeout_packet?.stage_attempt_id, 'sat-package-skill-projection');
    const invocation = fs.readFileSync(invocationLog, 'utf8');
    assert.match(invocation, new RegExp(`HOME=${projection.projection_root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(invocation, new RegExp(`CODEX_HOME=${expectedCodexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(invocation, /skills\.config=\[\{name="fixture-hosted-agent",enabled=false\}/);
    assert.match(invocation, /shell_environment_policy\.set\.HOME=/);
    assert.match(invocation, /\$fixture-hosted-agent/);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    if (previousCodexBin === undefined) delete process.env.OPL_CODEX_BIN;
    else process.env.OPL_CODEX_BIN = previousCodexBin;
    if (previousSandbox === undefined) delete process.env.OPL_CODEX_STAGE_SANDBOX_PROVIDER;
    else process.env.OPL_CODEX_STAGE_SANDBOX_PROVIDER = previousSandbox;
    makeTreeWritable(fixtureRoot);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(fakeCodex.fixtureRoot, { recursive: true, force: true });
  }
});
