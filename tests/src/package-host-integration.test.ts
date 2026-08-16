import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Context } from '@deepseek-ai/cordis';

import { parseJsonText } from '../../src/kernel/json-file.ts';
import {
  buildPackageHostContext,
  readCapabilityPackageHostContract,
  readStandardAgentHostContract,
  readWorkflowProfileHostContract,
  resolvePackageHostIntegration,
  type PackageHostManifest,
} from '../../src/authority/packages/package-host-integration.ts';
import {
  buildCordisCompositionSnapshot,
} from '../../src/authority/packages/index.ts';
import {
  cordisPackageHostPlugin,
  CORDIS_PACKAGE_HOST_SERVICE,
} from '../../src/host/plugins/cordis-package-host-plugin.ts';
import { CORDIS_BASE_HEADLESS_PLUGIN_DESCRIPTORS } from '../../src/host/composition-profiles.ts';
import {
  CORDIS_FRAMEWORK_INTEGRITY,
  CORDIS_FRAMEWORK_PACKAGE,
  CORDIS_FRAMEWORK_VERSION,
} from '../../src/host/plugins/cordis-agent-executor-experiment.ts';
import { buildCordisRunwayAttemptCompositionSnapshot } from '../../src/host/plugins/cordis-runway-attempt.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function readJson(relativePath: string): Record<string, unknown> {
  return parseJsonText(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as Record<string, unknown>;
}

function profileSnapshot() {
  return buildCordisCompositionSnapshot({
    framework: {
      package: CORDIS_FRAMEWORK_PACKAGE,
      version: CORDIS_FRAMEWORK_VERSION,
      integrity: CORDIS_FRAMEWORK_INTEGRITY,
    },
    binding: {
      executor_adapter_id: 'package-host-test',
      executor_route: 'opl.profile.base-headless',
    },
    foundry_evidence_ref: null,
    plugins: CORDIS_BASE_HEADLESS_PLUGIN_DESCRIPTORS,
  });
}

test('default host contracts classify standard agents, capability packages, and workflow profiles', () => {
  const cases = [
    ['contracts/opl-framework/packages/mas.json', 'standard_agent_runtime'],
    ['contracts/opl-framework/packages/mag.json', 'standard_agent_runtime'],
    ['contracts/opl-framework/packages/rca.json', 'standard_agent_runtime'],
    ['contracts/opl-framework/packages/oma.json', 'standard_agent_runtime'],
    ['contracts/opl-framework/packages/obf.json', 'standard_agent_runtime'],
    ['contracts/opl-framework/packages/mas-scholar-skills.json', 'capability_provider'],
    ['contracts/opl-framework/packages/opl-persona.json', 'capability_provider'],
    ['contracts/opl-framework/packages/opl-relay.json', 'capability_provider'],
    ['contracts/opl-framework/packages/opl-flow.json', 'workflow_profile_source'],
  ] as const;
  for (const [relativePath, expectedKind] of cases) {
    const manifest = readJson(relativePath) as PackageHostManifest;
    assert.equal(resolvePackageHostIntegration(manifest).integration_kind, expectedKind, relativePath);
  }
  assert.equal(readStandardAgentHostContract().standalone_policy, 'allowed');
  assert.equal(readCapabilityPackageHostContract().standalone_policy, 'allowed');
  assert.deepEqual(readCapabilityPackageHostContract().channel_provider, {
    host_service_id: 'opl.connect.channel-provider-host',
    callback_api_version: '1.0.0',
    activation: 'optional_shell_injected',
    provider_source: 'installed_descriptor_entrypoint',
    provider_identity: 'manifest_package_id',
    thread_binding_fields: ['provider_id', 'account_id', 'channel_session_id'],
    thread_ref_fields: ['canonical_thread_host', 'canonical_thread_id'],
    turn_ref_field: 'canonical_turn_id',
    methods: ['startThread', 'resumeThread', 'startTurn', 'subscribeTurn'],
    terminal_statuses: ['completed', 'failed', 'cancelled'],
    subscription_lifecycle: 'disposable',
    transport_boundary: 'current_shell_codex_app_server_only',
    forbidden_surfaces: [
      'unrestricted_json_rpc',
      'second_app_server',
      'secret_persistence',
      'thread_persistence',
    ],
  });
  assert.equal(
    readCapabilityPackageHostContract().integration_points.some(
      (point) => point.trigger === 'channel_provider'
        && point.allowed_profiles.length === 1
        && point.allowed_profiles[0] === 'app-full',
    ),
    true,
  );
  assert.equal(readWorkflowProfileHostContract().standalone_policy, 'allowed');
});

test('host context resolves standard stage services and remains digest-stable across snapshot order', () => {
  const snapshot = profileSnapshot();
  const attemptSnapshot = buildCordisRunwayAttemptCompositionSnapshot();
  const integration = readStandardAgentHostContract();
  const first = buildPackageHostContext({
    package_id: 'mas',
    integration,
    integration_trigger: 'stage_binding',
    environment: {
      profile_id: 'base-headless',
      snapshots: [
        { composition_id: 'profile:base-headless', snapshot },
        { composition_id: 'child:runway-attempt', snapshot: attemptSnapshot },
      ],
    },
  });
  const second = buildPackageHostContext({
    package_id: 'mas',
    integration,
    integration_trigger: 'stage_binding',
    environment: {
      profile_id: 'base-headless',
      snapshots: [
        { composition_id: 'child:runway-attempt', snapshot: attemptSnapshot },
        { composition_id: 'profile:base-headless', snapshot },
      ],
    },
  });
  assert.equal(first.status, 'ready');
  assert.equal(first.capabilities.required.every((entry) => entry.status === 'resolved'), true);
  assert.equal(first.context_digest, second.context_digest);
  assert.equal(first.context_id, `opl:host-context:${first.context_digest}`);
});

test('capability and workflow packages get non-blocking descriptor host contexts', () => {
  const snapshot = profileSnapshot();
  for (const [packageId, manifest, trigger] of [
    ['opl-persona', readJson('contracts/opl-framework/packages/opl-persona.json') as PackageHostManifest, 'descriptor_discovery'],
    ['mas-scholar-skills', readJson('contracts/opl-framework/packages/mas-scholar-skills.json') as PackageHostManifest, 'descriptor_discovery'],
    ['opl-flow', readJson('contracts/opl-framework/packages/opl-flow.json') as PackageHostManifest, 'profile_materialization'],
  ] as const) {
    const context = buildPackageHostContext({
      package_id: packageId,
      integration: resolvePackageHostIntegration(manifest),
      integration_trigger: trigger,
      environment: {
        profile_id: 'base-headless',
        snapshots: [{ composition_id: 'profile:base-headless', snapshot }],
      },
    });
    assert.equal(context.status, 'ready', packageId);
    assert.equal(context.capabilities.required.every((entry) => entry.status === 'resolved'), true, packageId);
  }
});

test('Cordis package host plugin exposes the same resolver to hosted Packages', async () => {
  const context = new Context();
  const fiber = await context.plugin(cordisPackageHostPlugin, { profile_id: 'base-headless' });
  try {
    const service = context.get(CORDIS_PACKAGE_HOST_SERVICE);
    assert.ok(service);
    const manifest = readJson('contracts/opl-framework/packages/mas.json') as PackageHostManifest;
    const resolved = service.resolve({
      manifest,
      integration_trigger: 'handler_ref',
      composition_snapshot: profileSnapshot(),
    });
    assert.equal(resolved.status, 'ready');
    assert.equal(resolved.package_id, 'mas');
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
});
