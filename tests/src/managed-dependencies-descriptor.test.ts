import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readOplFlowManagedDependencies,
  readOplFlowManagedDependencyIds,
} from '../../src/modules/connect/agent-package-registry.ts';
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
    package: { id: 'opl-flow', version: '0.1.28', owner: 'opl-flow', kind: 'workflow_profile' },
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
    assert.deepEqual(readOplFlowManagedDependencyIds(), ['opl-base', 'agent-reach', 'officecli']);
    assert.deepEqual(readOplFlowManagedDependencies(), [
      {
        dependency_id: 'opl-base',
        dependency_kind: 'base',
        activation: 'always',
        offline_bundle: 'none',
        online_install_default: true,
        source: 'gaofeng21cn/one-person-lab',
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
        lifecycle_owner: 'opl_base',
        update_mode: 'detect_only_guidance',
        observed_status: null,
        installed: null,
      },
    ]);
    assert.equal(fs.existsSync(path.join(stateRoot, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(stateRoot, 'agent-package-lifecycle-ledger.json')), false);
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
