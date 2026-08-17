import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readOplFlowManagedDependencies,
  readOplFlowManagedDependencyIds,
} from '../../src/adapters/integration/agent-package-registry.ts';
import { agentPackageManifest, formatJsonPayload } from './cli/cases/packages-cases/helpers.ts';

function writeFakePluginList(root: string, sourceRoot: string) {
  const binary = path.join(root, 'fake-codex');
  fs.writeFileSync(binary, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify({
  installed: [{
    pluginId: 'opl-flow@fixture-marketplace',
    version: '0.1.28',
    enabled: true,
    source: { source: 'local', path: sourceRoot },
    marketplaceSource: { sourceType: 'local', source: sourceRoot },
  }],
}))});
`, { mode: 0o755 });
  return binary;
}

function writeEmptyPluginList(root: string) {
  const binary = path.join(root, 'fake-empty-codex');
  fs.writeFileSync(binary, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify({ installed: [] }))});
`, { mode: 0o755 });
  return binary;
}

function writeLegacyDependencyLock(stateRoot: string) {
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'agent-package-locks.json'), formatJsonPayload({
    surface_kind: 'opl_agent_package_lock_index',
    version: 'opl-agent-package-lock-index.v1',
    packages: [{
      package_id: 'opl-flow',
      lock_ref: 'opl://agent-package-lock/opl-flow/legacy',
      physical_surface: {
        workflow_policy_migration: {
          dependency_ids: ['opl-base', 'officecli'],
          dependencies: [{
            id: 'opl-base',
            kind: 'base',
            activation: 'always',
            offline_bundle: 'full',
            online_install_default: true,
            source: 'legacy-lock',
          }],
          dependency_sync: {
            tools: [{ tool_id: 'officecli', status: 'ready' }],
          },
        },
      },
    }],
  }));
}

test('managed dependencies read from the installed owner descriptor policy without lock state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-managed-dependencies-descriptor-'));
  const sourceRoot = path.join(root, 'opl-flow');
  const stateRoot = path.join(root, 'state');
  const policyPath = path.join(sourceRoot, 'contracts', 'workflow-policy.json');
  const manifest = agentPackageManifest({
    packageId: 'opl-flow',
    agentId: 'opl-flow',
    pluginId: 'opl-flow',
    distributionPayload: null,
    profileSurface: {
      runtime_profile: { source_path: 'templates/AGENTS.md', target_id: 'user_agents_profile' },
      authoring_sources: [],
      merge_context_paths: [],
      existing_profile_policy: 'semantic_merge_required',
    },
  }) as unknown as Record<string, unknown>;
  manifest.source = 'first_party';
  manifest.publisher = 'one-person-lab';
  manifest.managed_policy_surface = {
    policy_kind: 'opl_flow_workflow_policy',
    source_path: 'contracts/workflow-policy.json',
    schema_path: 'contracts/workflow-policy.schema.json',
  };
  const policy = {
    schema: 'opl_flow_workflow_policy.v3',
    package: { id: 'opl-flow', version: '1.2.3', owner: 'opl-flow', kind: 'workflow_profile' },
    requires: [
      {
        id: 'opl-base',
        kind: 'base',
        owner: 'one-person-lab',
        online_install_default: true,
        activation: 'always',
        source: 'gaofeng21cn/one-person-lab',
      },
      {
        id: 'agent-reach',
        kind: 'codex_skill',
        owner: 'agent-reach',
        online_install_default: true,
        activation: 'task_routed',
        source: 'https://github.com/Panniantong/Agent-Reach',
        source_path: 'agent_reach/skill',
      },
      {
        id: 'officecli',
        kind: 'cli',
        owner: 'iofficeai',
        online_install_default: false,
        activation: 'task_routed',
        source: 'officecli',
      },
    ],
    recommends: [
      {
        id: 'mineru-open-api',
        kind: 'cli',
        owner: 'mineru',
        online_install_default: false,
        activation: 'task_routed',
        source: 'mineru-open-api',
      },
    ],
  };
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'opl-package.json'), formatJsonPayload(manifest));
  fs.writeFileSync(policyPath, formatJsonPayload(policy));
  fs.writeFileSync(
    path.join(sourceRoot, 'templates', 'AGENTS.md'),
    'descriptor dependency fixture\n',
  );

  const previous = {
    codexHome: process.env.CODEX_HOME,
    stateDir: process.env.OPL_STATE_DIR,
    pluginBin: process.env.OPL_CODEX_PLUGIN_BIN,
  };
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  process.env.OPL_STATE_DIR = stateRoot;
  process.env.OPL_CODEX_PLUGIN_BIN = writeFakePluginList(root, sourceRoot);

  try {
    assert.deepEqual(readOplFlowManagedDependencyIds(), [
      'opl-base',
      'agent-reach',
      'officecli',
      'mineru-open-api',
    ]);
    assert.deepEqual(readOplFlowManagedDependencies(), [
      {
        dependency_id: 'opl-base',
        dependency_kind: 'base',
        activation: 'always',
        offline_bundle: 'none',
        online_install_default: true,
        source: 'gaofeng21cn/one-person-lab',
        source_path: null,
        owner: 'one-person-lab',
        bundle_id: null,
        version_requirement: null,
        install_source: null,
        relationship: 'required',
        lifecycle_owner: 'opl_base',
        update_mode: 'silent_managed',
        observed_status: null,
        installed: true,
      },
      {
        dependency_id: 'agent-reach',
        dependency_kind: 'codex_skill',
        activation: 'task_routed',
        offline_bundle: 'none',
        online_install_default: true,
        source: 'https://github.com/Panniantong/Agent-Reach',
        source_path: 'agent_reach/skill',
        owner: 'agent-reach',
        bundle_id: null,
        version_requirement: null,
        install_source: null,
        relationship: 'required',
        lifecycle_owner: 'opl_packages',
        update_mode: 'silent_managed',
        observed_status: null,
        installed: null,
      },
      {
        dependency_id: 'officecli',
        dependency_kind: 'cli',
        activation: 'task_routed',
        offline_bundle: 'none',
        online_install_default: false,
        source: 'officecli',
        source_path: null,
        owner: 'iofficeai',
        bundle_id: null,
        version_requirement: null,
        install_source: null,
        relationship: 'required',
        lifecycle_owner: 'opl_base',
        update_mode: 'detect_only_guidance',
        observed_status: null,
        installed: null,
      },
      {
        dependency_id: 'mineru-open-api',
        dependency_kind: 'cli',
        activation: 'task_routed',
        offline_bundle: 'none',
        online_install_default: false,
        source: 'mineru-open-api',
        source_path: null,
        owner: 'mineru',
        bundle_id: null,
        version_requirement: null,
        install_source: null,
        relationship: 'recommended',
        lifecycle_owner: 'opl_base',
        update_mode: 'detect_only_guidance',
        observed_status: null,
        installed: null,
      },
    ]);
    assert.equal(fs.existsSync(path.join(stateRoot, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(stateRoot, 'agent-package-lifecycle-ledger.json')), false);

    fs.writeFileSync(policyPath, formatJsonPayload({
      ...policy,
      package: { ...policy.package, id: 'not-opl-flow' },
    }));
    assert.deepEqual(readOplFlowManagedDependencyIds(), []);
    assert.deepEqual(readOplFlowManagedDependencies(), []);
    fs.writeFileSync(policyPath, formatJsonPayload(policy));

    const outsidePolicyPath = path.join(root, 'outside-workflow-policy.json');
    fs.renameSync(policyPath, outsidePolicyPath);
    fs.symlinkSync(outsidePolicyPath, policyPath);
    assert.deepEqual(readOplFlowManagedDependencyIds(), []);
    assert.deepEqual(readOplFlowManagedDependencies(), []);

    fs.unlinkSync(policyPath);
    fs.writeFileSync(policyPath, '{invalid policy');
    assert.deepEqual(readOplFlowManagedDependencyIds(), []);
    assert.deepEqual(readOplFlowManagedDependencies(), []);
  } finally {
    if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.codexHome;
    if (previous.stateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previous.stateDir;
    if (previous.pluginBin === undefined) delete process.env.OPL_CODEX_PLUGIN_BIN;
    else process.env.OPL_CODEX_PLUGIN_BIN = previous.pluginBin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy lock dependency metadata does not provide managed dependency authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-managed-dependencies-legacy-lock-'));
  const stateRoot = path.join(root, 'state');
  writeLegacyDependencyLock(stateRoot);
  const previous = {
    codexHome: process.env.CODEX_HOME,
    stateDir: process.env.OPL_STATE_DIR,
    pluginBin: process.env.OPL_CODEX_PLUGIN_BIN,
  };
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  process.env.OPL_STATE_DIR = stateRoot;
  process.env.OPL_CODEX_PLUGIN_BIN = writeEmptyPluginList(root);

  try {
    assert.deepEqual(readOplFlowManagedDependencyIds(), []);
    assert.deepEqual(readOplFlowManagedDependencies(), []);
  } finally {
    if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.codexHome;
    if (previous.stateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previous.stateDir;
    if (previous.pluginBin === undefined) delete process.env.OPL_CODEX_PLUGIN_BIN;
    else process.env.OPL_CODEX_PLUGIN_BIN = previous.pluginBin;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
