import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseJsonText } from '../../src/kernel/json-file.ts';
import { validateJsonSchemaPayload } from '../../src/kernel/schema-registry.ts';
import {
  createCordisAppFullComposition,
  createCordisBaseHeadlessComposition,
  createCordisFoundryDevComposition,
} from '../../src/entrypoints/cordis/composition-profiles.ts';
import {
  buildCordisAgentExecutorCompositionSnapshot,
  buildCordisPackStagecraftCompositionSnapshot,
} from '../../src/modules/runway/cordis-agent-executor-experiment.ts';
import { buildCordisRunwayAttemptCompositionSnapshot } from '../../src/modules/runway/cordis-runway-attempt.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const contractRef = 'contracts/opl-framework/cordis-architecture-profile.json';
const schemaRef = 'contracts/opl-framework/cordis-architecture-profile.schema.json';
const sourceModuleMapRef = 'contracts/opl-framework/source-module-map.json';

type JsonObject = Record<string, any>;

function readJson(relativePath: string): JsonObject {
  return parseJsonText(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as JsonObject;
}

function repoPath(ref: string): string {
  return ref.split('#', 1)[0];
}

function assertRepoRefs(refs: string[], label: string) {
  for (const ref of refs) {
    assert.equal(fs.existsSync(path.join(repoRoot, repoPath(ref))), true, `${label}: missing ${ref}`);
  }
}

test('Cordis architecture profile is valid against its machine contract', () => {
  const result = validateJsonSchemaPayload({
    schemaId: 'opl.cordis_architecture_profile.v1',
    schema: readJson(schemaRef),
    sourceRef: schemaRef,
  }, readJson(contractRef));
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.errors));
});

test('Cordis architecture profile freezes the four-layer model and ten-module mapping', () => {
  const profile = readJson(contractRef);
  const sourceMap = readJson(sourceModuleMapRef);
  assert.deepEqual(
    profile.architecture_layers.map((layer: JsonObject) => layer.layer_id),
    ['authority_domain', 'package', 'cordis_plugin_contribution', 'curated_composition_profile'],
  );
  assert.deepEqual(
    profile.source_to_target_mapping.map((entry: JsonObject) => entry.source_module_id),
    sourceMap.modules.map((entry: JsonObject) => entry.module_id),
  );
  const dispositions = new Set(profile.source_to_target_mapping.map((entry: JsonObject) => entry.module_disposition));
  for (const disposition of ['retain', 'split', 'merge', 'demote']) assert.equal(dispositions.has(disposition), true);
  for (const entry of profile.source_to_target_mapping) {
    assertRepoRefs([entry.source_entrypoint, ...entry.authority_continues_refs], entry.source_module_id);
    for (const contribution of entry.target_contributions) {
      assertRepoRefs([...contribution.source_refs, ...contribution.caller_refs], contribution.plugin_id);
      assert.equal(contribution.forbidden_authorities.every((authority: string) =>
        profile.authority_boundary.forbidden_authorities.includes(authority)), true);
    }
  }
});

test('profiles are explicit allowlists with only real caller evidence', () => {
  const profile = readJson(contractRef);
  assert.deepEqual(
    profile.profiles.map((entry: JsonObject) => entry.profile_id),
    ['base-headless', 'app-full', 'foundry-dev'],
  );
  const contributions = new Set<string>();
  for (const entry of profile.source_to_target_mapping) {
    for (const contribution of entry.target_contributions) contributions.add(contribution.plugin_id);
  }
  for (const selected of profile.profiles) {
    assertRepoRefs(selected.caller_refs, `${selected.profile_id} caller`);
    for (const plugin of selected.plugin_allowlist) assert.equal(contributions.has(plugin.plugin_id), true, plugin.plugin_id);
  }
  assert.equal(profile.profiles.some((entry: JsonObject) => entry.default_candidate), true);
  assert.equal(profile.cutover.current_default_profile, 'base-headless');
  assert.equal(profile.cutover.p6.status, 'landed');
});

test('profile runtime snapshots match their root and child composition allowlists', async () => {
  const contract = readJson(contractRef);
  const compositions = [
    await createCordisBaseHeadlessComposition(),
    await createCordisAppFullComposition({
      runtimeSnapshotProvider: async () => ({ runtime_tray_snapshot: {} }),
    }),
    await createCordisFoundryDevComposition(),
  ];
  try {
    for (const composition of compositions) {
      const profile = contract.profiles.find(
        (entry: JsonObject) => entry.profile_id === composition.profileId,
      );
      assert.ok(profile, composition.profileId);
      const allowed = new Map<string, boolean>(
        profile.plugin_allowlist.map((entry: JsonObject) => [entry.plugin_id, entry.required]),
      );
      const runtime = new Map<string, boolean>(
        composition.snapshot.plugins.map((entry) => [entry.plugin_id, entry.required]),
      );
      assert.deepEqual(
        [...runtime.keys()].sort(),
        [...allowed.entries()]
          .filter(([pluginId, required]) => required || runtime.has(pluginId))
          .map(([pluginId]) => pluginId)
          .sort(),
        `${composition.profileId}: runtime root plugin set`,
      );
      for (const [pluginId, required] of allowed) {
        if (required) assert.equal(runtime.get(pluginId), true, `${composition.profileId}:${pluginId}`);
      }
      assert.deepEqual(
        Object.keys(composition.snapshot.binding.child_composition_snapshot_refs ?? {}).sort(),
        [...profile.child_composition_allowlist].sort(),
        `${composition.profileId}: child composition set`,
      );
    }
  } finally {
    for (const composition of compositions.reverse()) await composition.dispose();
  }
});

test('every profile and child descriptor source identity resolves to reachable Git bytes', async () => {
  const compositions = [
    await createCordisBaseHeadlessComposition(),
    await createCordisAppFullComposition({
      runtimeSnapshotProvider: async () => ({ runtime_tray_snapshot: {} }),
    }),
    await createCordisFoundryDevComposition(),
  ];
  try {
    const descriptors = [
      ...compositions.flatMap((composition) => composition.snapshot.plugins),
      ...buildCordisAgentExecutorCompositionSnapshot().plugins,
      ...buildCordisRunwayAttemptCompositionSnapshot().plugins,
      ...buildCordisPackStagecraftCompositionSnapshot().plugins,
    ];
    for (const descriptor of descriptors) {
      assert.doesNotThrow(() => execFileSync(
        'git',
        ['cat-file', '-e', `${descriptor.source_commit}:${descriptor.source_ref}`],
        { cwd: repoRoot, stdio: 'pipe' },
      ), descriptor.source_identity);
      assert.doesNotThrow(() => execFileSync(
        'git',
        ['merge-base', '--is-ancestor', descriptor.source_commit, 'HEAD'],
        { cwd: repoRoot, stdio: 'pipe' },
      ), `${descriptor.source_identity}: source commit is not reachable from HEAD`);
    }
  } finally {
    for (const composition of compositions.reverse()) await composition.dispose();
  }
});

test('authority boundaries and retirement gates do not create a second registry or lifecycle', () => {
  const profile = readJson(contractRef);
  const forbidden = new Set(profile.authority_boundary.forbidden_authorities);
  for (const required of [
    'package_currentness',
    'temporal_workflow_history',
    'temporal_retry_replay',
    'workspace_file_bytes',
    'workspace_binding_registry',
    'ledger_evidence_persistence',
    'ledger_receipt_authority',
    'foundry_agent_version',
    'foundry_promotion_activation',
    'domain_truth',
    'domain_quality_verdict',
    'app_product_truth',
  ]) assert.equal(forbidden.has(required), true, required);
  assert.equal(profile.authority_boundary.cordis_is_security_sandbox, false);
  assert.equal(profile.cutover.legacy_caller_zero_gate.required, true);
  assert.equal(profile.cutover.default_switch_gate.owner_readback_required, true);
  assert.equal(profile.cutover.retirement_rule.permanent_dual_write_forbidden, true);
  assert.equal(profile.cutover.retirement_rule.automatic_legacy_fallback_forbidden, true);
  for (const key of ['registry', 'installed', 'lock', 'currentness', 'resolver']) {
    assert.equal(Object.prototype.hasOwnProperty.call(profile, key), false, `unexpected second-truth key: ${key}`);
  }
});
