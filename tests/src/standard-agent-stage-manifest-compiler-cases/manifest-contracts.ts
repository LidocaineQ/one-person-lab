import * as shared from './shared.ts';
import assert from 'node:assert/strict';

const {
  spawnSync,
  fs,
  os,
  path,
  test,
  buildDomainPackCompilerList,
  buildGeneratedAgentInterfaces,
  buildRepoGeneratedInterfaceBundle,
  buildStandardAgentRepoContractReadout,
  compileStandardAgentStageManifest,
  resolveStandardAgentStageQualityRuntimeBinding,
  FrameworkContractError,
  normalizeFamilyStageControlPlane,
  buildReadyAgentRepo,
  retargetReadyRepo,
  HOSTED_FOUNDRY_GENERATED_SURFACE_HANDOFF_DEFAULTS_PROFILE,
  resolveGeneratedSurfaceHandoffContract,
  STANDARD_GENERATED_SURFACE_HANDOFF_DEFAULTS_PROFILE,
  REPO_ROOT,
  writeJson,
  writeText,
  resolvePython3Executable,
  writePrimaryOnlyDeliverPolicy,
  fixture,
  readManifest,
  writeManifest,
} = shared;
type JsonRecord = shared.JsonRecord;

test('standard Agent stage manifest compiler requires every declared pack source', () => {
  const root = fixture('target-missing-required-source');
  const ref = path.join(root, 'contracts/pack_compiler_input.json');
  const input = JSON.parse(fs.readFileSync(ref, 'utf8')) as JsonRecord;
  input.required_domain_pack_paths = [
    ...(input.required_domain_pack_paths as string[]),
    'agent/prompts/definitely-missing.md',
  ];
  writeJson(root, 'contracts/pack_compiler_input.json', input);
  assert.throws(() => compileStandardAgentStageManifest(root));
});

test('standard Agent stage manifest compiler fails closed for malformed identity, refs, actions, and transitions', async (t) => {
  const cases: Array<[string, (root: string, manifest: JsonRecord) => unknown]> = [
    ['nonobject', (_root) => []],
    ['wrong domain', (_root, manifest) => ({ ...manifest, target_domain_id: 'other' })],
    ['empty stages', (_root, manifest) => ({ ...manifest, stages: [] })],
    ['duplicate stage', (_root, manifest) => ({ ...manifest, stages: [manifest.stages[0], manifest.stages[0]] })],
    ['path traversal', (_root, manifest) => ({
      ...manifest,
      stages: [{ ...manifest.stages[0], policy_ref: '../outside.md' }, manifest.stages[1]],
    })],
    ['missing ref', (_root, manifest) => ({
      ...manifest,
      stages: [{ ...manifest.stages[0], prompt_ref: 'agent/prompts/missing.md' }, manifest.stages[1]],
    })],
    ['missing action', (_root, manifest) => ({
      ...manifest,
      stages: [{ ...manifest.stages[0], allowed_action_refs: ['unknown'] }, manifest.stages[1]],
    })],
    ['empty action refs', (_root, manifest) => ({
      ...manifest,
      stages: [{ ...manifest.stages[0], allowed_action_refs: [] }, manifest.stages[1]],
    })],
    ['empty quality gate refs', (_root, manifest) => ({
      ...manifest,
      stages: [{ ...manifest.stages[0], quality_gate_refs: [] }, manifest.stages[1]],
    })],
    ['unresolved transition', (_root, manifest) => ({
      ...manifest,
      stages: [{ ...manifest.stages[0], next_stage_refs: ['missing'] }, manifest.stages[1]],
    })],
    ['mixed source and target-only provenance', (_root, manifest) => ({
      ...manifest,
      stages: [{
        ...manifest.stages[0],
        stage_origin: 'source_pattern_ref',
        pattern_id: 'source-pattern',
        step_id: 'intake-step',
        provenance_kind: 'source_derived',
        source_pattern_ref: 'pattern-ref:source/intake',
        source_anchor_refs: ['source-ref:paper#intake'],
        target_only_requirement_ref: 'target-only-requirement:target-negative/intake',
      }, manifest.stages[1]],
    })],
    ['mixed target-only and source provenance', (_root, manifest) => ({
      ...manifest,
      stages: [{
        ...manifest.stages[0],
        stage_origin: 'target_only_requirement',
        target_only_requirement_ref: 'target-only-requirement:target-negative/intake',
        pattern_id: 'source-pattern',
        step_id: 'intake-step',
        provenance_kind: 'source_derived',
        source_pattern_ref: 'pattern-ref:source/intake',
        source_anchor_refs: ['source-ref:paper#intake'],
      }, manifest.stages[1]],
    })],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const root = fixture('target-negative');
      writeManifest(root, mutate(root, readManifest(root)));
      assert.throws(() => compileStandardAgentStageManifest(root));
    });
  }
});

test('repo descriptor never falls back to the legacy tracked stage control plane', () => {
  const root = fixture('target-no-fallback');
  fs.rmSync(path.join(root, 'agent/stages/manifest.json'));
  writeJson(root, 'contracts/stage_control_plane.json', {
    surface_kind: 'family_stage_control_plane',
    version: 'family-stage-control-plane.v1',
    plane_id: 'legacy',
    target_domain_id: 'target-no-fallback',
    owner: 'target-no-fallback',
    authority_boundary: {},
    stages: [{
      stage_id: 'legacy',
      stage_kind: 'intake',
      title: 'Legacy',
      goal: 'Legacy.',
      owner: 'target-no-fallback',
      authority_boundary: {},
    }],
  });
  assert.throws(() => buildRepoGeneratedInterfaceBundle(root, 'product-entry'));
});

test('stage manifest compiler rejects missing default receipt and authority-function refs', async (t) => {
  for (const ref of [
    'contracts/owner_receipt_contract.json',
    'runtime/authority_functions/README.md',
  ]) {
    await t.test(ref, () => {
      const root = fixture('target-missing-default-ref');
      fs.rmSync(path.join(root, ref));
      assert.throws(() => compileStandardAgentStageManifest(root));
    });
  }
});

test('stage manifest compiler rejects malformed or non-object owner receipt contracts', async (t) => {
  for (const [name, source] of [
    ['malformed', '{'],
    ['non-object', '[]'],
    ['foreign-kind', '{"surface_kind":"foreign_owner_receipt_contract"}'],
  ] as const) {
    await t.test(name, () => {
      const root = fixture(`target-owner-receipt-${name}`);
      fs.writeFileSync(path.join(root, 'contracts/owner_receipt_contract.json'), source);
      assert.throws(() => compileStandardAgentStageManifest(root));
    });
  }
});

test('stage manifest compiler requires canonical manifest kind, version, and truth owner', async (t) => {
  const cases: Array<[string, (manifest: JsonRecord) => void]> = [
    ['surface_kind', (manifest) => { manifest.surface_kind = 'foreign_stage_manifest'; }],
    ['version', (manifest) => { manifest.version = 'opl-standard-agent-declarative-stage-manifest.v999'; }],
    ['domain_truth_owner', (manifest) => {
      manifest.authority_boundary.domain_truth_owner = 'foreign-owner';
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const root = fixture(`target-manifest-${name.replaceAll('_', '-')}`);
      const manifest = readManifest(root);
      mutate(manifest);
      writeManifest(root, manifest);
      assert.throws(() => compileStandardAgentStageManifest(root));
    });
  }
});

test('stage manifest compiler rejects OPL authority ownership and non-boolean authority gates', async (t) => {
  const cases: Array<[string, (authority: JsonRecord) => void]> = [
    ['quality_verdict_owner', (authority) => { authority.quality_verdict_owner = 'one-person-lab'; }],
    ['quality_verdict_owner_whitespace', (authority) => { authority.quality_verdict_owner = ' one-person-lab '; }],
    ['artifact_authority_owner', (authority) => { authority.artifact_authority_owner = 'one-person-lab'; }],
    ['artifact_authority_owner_whitespace', (authority) => { authority.artifact_authority_owner = ' one-person-lab '; }],
    ['non_boolean_opl_gate', (authority) => { authority.opl_can_write_domain_truth = 'true'; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const root = fixture(`target-authority-${name.replaceAll('_', '-')}`);
      const manifest = readManifest(root);
      mutate(manifest.authority_boundary);
      writeManifest(root, manifest);
      assert.throws(() => compileStandardAgentStageManifest(root), FrameworkContractError);
    });
  }
});

test('stage manifest compiler rejects present non-object stage contracts', async (t) => {
  for (const value of [[], 'invalid-stage-contract']) {
    await t.test(JSON.stringify(value), () => {
      const root = fixture('target-invalid-stage-contract');
      const manifest = readManifest(root);
      manifest.stages[0].stage_contract = value;
      writeManifest(root, manifest);
      assert.throws(() => compileStandardAgentStageManifest(root), FrameworkContractError);
    });
  }
});

test('stage manifest compiler projects generic stage-contract extensions', () => {
  const root = fixture('target-stage-contract-extension');
  writePrimaryOnlyDeliverPolicy(root);
  const manifest = readManifest(root);
  const extension = {
    domain_gate: {
      surface_kind: 'domain_stage_gate',
      fail_closed: true,
    },
    monitor_refs: [{
      ref_kind: 'surface_kind',
      ref: 'domain_stage_monitor',
      role: 'domain_stage_monitor',
    }],
    review_input_snapshot_transport: {
      review_lane_binding: 'controller_required',
      allowed_review_lanes: ['medical', 'display'],
      executor_may_select_lane: false,
      lane_fallback: false,
    },
  };
  manifest.stages[1].stage_quality_cycle_policy_ref =
    'contracts/stage_quality_cycle_policy.json#/stages/deliver';
  manifest.stages[1].stage_contract_extension = extension;
  writeManifest(root, manifest);

  const stageContract = compileStandardAgentStageManifest(root).stage_control_plane.stages[1]
    ?.stage_contract as JsonRecord;
  assert.deepEqual(stageContract.domain_gate, extension.domain_gate);
  assert.deepEqual(stageContract.monitor_refs, extension.monitor_refs);
  assert.deepEqual(
    resolveStandardAgentStageQualityRuntimeBinding(root, manifest.stages[1].stage_id)
      ?.review_lane_binding,
    {
      binding_kind: 'controller_required',
      allowed_review_lanes: ['medical', 'display'],
      executor_may_select_lane: false,
      lane_fallback: false,
    },
  );
});
