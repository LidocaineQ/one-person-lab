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

test('standard Agent stage manifest compiler preserves exclusive source-derived provenance', () => {
  const root = fixture('target-provenance');
  const manifest = readManifest(root);
  manifest.stages[0] = {
    ...manifest.stages[0],
    stage_origin: 'source_pattern_ref',
    pattern_id: 'source-pattern',
    step_id: 'intake-step',
    provenance_kind: 'source_derived',
    source_pattern_ref: 'pattern-ref:source/intake',
    source_anchor_refs: ['source-ref:paper#intake'],
  };
  manifest.stages[1] = {
    ...manifest.stages[1],
    stage_origin: 'target_only_requirement',
    target_only_requirement_ref: 'target-only-requirement:target-provenance/deliver',
  };
  writeManifest(root, manifest);

  const compilation = compileStandardAgentStageManifest(root);
  assert.equal(compilation.stage_control_plane.stages[0]?.stage_origin, 'source_pattern_ref');
  assert.equal(compilation.stage_control_plane.stages[0]?.pattern_id, 'source-pattern');
  assert.equal(compilation.stage_control_plane.stages[0]?.step_id, 'intake-step');
  assert.equal(compilation.stage_control_plane.stages[0]?.source_pattern_ref, 'pattern-ref:source/intake');
  assert.deepEqual(
    compilation.stage_control_plane.stages[0]?.stage_pattern_source_refs,
    ['pattern-ref:source/intake'],
  );
  assert.equal(compilation.stage_control_plane.stages[1]?.stage_origin, 'target_only_requirement');
  assert.equal(
    compilation.stage_control_plane.stages[1]?.target_only_requirement_ref,
    'target-only-requirement:target-provenance/deliver',
  );
});

test('standard Agent stage manifest compiler rejects an alias as the primary source pattern ref', () => {
  const root = fixture('target-provenance-primary-mismatch');
  const manifest = readManifest(root);
  manifest.stages[0] = {
    ...manifest.stages[0],
    stage_origin: 'source_pattern_ref',
    pattern_id: 'source-pattern',
    step_id: 'intake-step',
    provenance_kind: 'source_derived',
    source_pattern_ref: 'pattern-ref:source/alias',
    source_anchor_refs: ['source-ref:paper#intake'],
    stage_pattern_source_refs: [
      'pattern-ref:source/intake',
      'pattern-ref:source/alias',
    ],
  };
  writeManifest(root, manifest);

  assert.throws(
    () => compileStandardAgentStageManifest(root),
    /primary source_pattern_ref must match stage_pattern_source_refs\[0\]/,
  );
});

test('standard Agent stage manifest compiler requires an explicit canonical agent id', async (t) => {
  for (const canonicalAgentId of [undefined, '', '   ']) {
    await t.test(JSON.stringify(canonicalAgentId), () => {
      const root = fixture('target-missing-agent-id');
      const ref = path.join(root, 'contracts/pack_compiler_input.json');
      const input = JSON.parse(fs.readFileSync(ref, 'utf8')) as JsonRecord;
      if (canonicalAgentId === undefined) {
        delete input.canonical_agent_id;
      } else {
        input.canonical_agent_id = canonicalAgentId;
      }
      writeJson(root, 'contracts/pack_compiler_input.json', input);
      assert.throws(() => compileStandardAgentStageManifest(root));
      const readout = buildStandardAgentRepoContractReadout(root);
      assert.equal(readout.status, 'blocked');
      assert.deepEqual(readout.blockers, ['invalid_contract:contracts/pack_compiler_input.json']);
    });
  }
});

test('standard Agent stage manifest compiler binds pack identity to the descriptor domain', () => {
  const root = fixture('target-pack-domain-mismatch');
  const ref = path.join(root, 'contracts/pack_compiler_input.json');
  const input = JSON.parse(fs.readFileSync(ref, 'utf8')) as JsonRecord;
  input.domain_id = 'other-domain';
  writeJson(root, 'contracts/pack_compiler_input.json', input);
  assert.throws(() => compileStandardAgentStageManifest(root));
});

test('pack compiler rejects requested Agent identity that differs from the repo canonical id', () => {
  const root = fixture('med-autoscience', 'mas');

  const report = buildDomainPackCompilerList({} as any, {
    familyDefaults: true,
    familyRepoInputs: [{ requested_agent_id: 'mag', repo_dir: root }],
  });
  const projection = report.domain_pack_compiler.domains[0];
  const errorDetails = projection?.repo_contract_error?.details as JsonRecord;

  assert.equal(report.domain_pack_compiler.summary.blocked_domain_count, 1);
  assert.equal(projection?.compiler_status, 'blocked');
  assert.equal(projection?.blocker_reasons.includes('identity_mismatch'), true);
  assert.equal(projection?.repo_contract_error?.code, 'contract_shape_invalid');
  assert.equal(errorDetails.requested_agent_id, 'mag');
  assert.equal(errorDetails.canonical_agent_id, 'mas');
});

test('generated interfaces family report blocks identity mismatch without aborting the report', () => {
  const root = fixture('med-autoscience', 'mas');
  const report = buildGeneratedAgentInterfaces({} as any, ['--family-defaults'], {
    familyRepoInputs: [{ requested_agent_id: 'mag', repo_dir: root }],
  }).generated_agent_interfaces as JsonRecord;
  const projection = report.reports[0] as JsonRecord;
  const error = projection.repo_contract_error as JsonRecord;
  const details = error.details as JsonRecord;

  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.summary, {
    total_domain_count: 1,
    ready_domain_count: 0,
    blocked_domain_count: 1,
  });
  assert.equal(projection.compiler_status, 'blocked');
  assert.deepEqual(projection.blocker_reasons, ['identity_mismatch']);
  assert.equal(error.code, 'contract_shape_invalid');
  assert.equal(details.requested_agent_id, 'mag');
  assert.equal(details.canonical_agent_id, 'mas');
  assert.equal(projection.generated_agent_interfaces.status, 'blocked');
});

test('family reports isolate unsupported stage fields as typed repo blockers', async (t) => {
  const cases: Array<[string, string]> = [
    ['stage_kind', 'unsupported_stage_kind'],
    ['trust_lane', 'unsupported_trust_lane'],
  ];

  for (const [field, value] of cases) {
    await t.test(field, () => {
      const blockedRoot = buildReadyAgentRepo();
      const readyRoot = buildReadyAgentRepo();
      retargetReadyRepo(blockedRoot, `invalid-${field}`, `Invalid ${field}`);
      retargetReadyRepo(readyRoot, `ready-${field}`, `Ready ${field}`);
      const manifest = readManifest(blockedRoot);
      manifest.stages[0][field] = value;
      writeManifest(blockedRoot, manifest);
      const familyRepoInputs = [
        { requested_agent_id: `invalid-${field}`, repo_dir: blockedRoot },
        { requested_agent_id: `ready-${field}`, repo_dir: readyRoot },
      ];

      const reports: JsonRecord[] = [
        buildDomainPackCompilerList({} as any, { familyDefaults: true, familyRepoInputs })
          .domain_pack_compiler as JsonRecord,
        buildGeneratedAgentInterfaces({} as any, ['--family-defaults'], { familyRepoInputs })
          .generated_agent_interfaces as JsonRecord,
      ];

      for (const report of reports) {
        const entries = (report.domains ?? report.reports) as JsonRecord[];
        const byAgent = new Map(entries.map((entry: JsonRecord) => [entry.requested_agent_id, entry]));
        const blocked = byAgent.get(`invalid-${field}`) as JsonRecord;
        const ready = byAgent.get(`ready-${field}`) as JsonRecord;
        assert.deepEqual(report.summary, {
          ...report.summary,
          total_domain_count: 2,
          ready_domain_count: 1,
          blocked_domain_count: 1,
        });
        assert.equal(blocked.compiler_status, 'blocked');
        assert.equal(blocked.repo_contract_error.code, 'contract_shape_invalid');
        assert.notEqual(blocked.repo_contract_error.code, 'unexpected_error');
        assert.equal(ready.compiler_status, 'ready');
      }
    });
  }
});

test('standard Agent repo contract readout blocks active private generic residue', () => {
  const root = fixture('target-private-residue');
  writeJson(root, 'contracts/functional_privatization_audit.json', {
    surface_kind: 'functional_privatization_audit',
    target_domain_id: 'target-private-residue',
    modules: [
      {
        module_id: 'repo_owned_generic_scheduler',
        classification: 'generic_scheduler_or_daemon',
        owner: 'target-private-residue',
        code_paths: ['runtime/legacy-scheduler.ts'],
        active_callers: ['legacy local cadence'],
        active_caller_status: 'active_private_scheduler_still_called',
        migration_action: 'move_to_opl_provider_scheduler_then_tombstone',
      },
    ],
  });

  const readout = buildStandardAgentRepoContractReadout(root);
  assert.equal(readout.status, 'blocked');
  assert.deepEqual(readout.blockers, [
    'functional_privatization_audit_has_generic_residue_or_blocker',
  ]);
});

test('standard Agent repo contracts reject generated-surface authority escalation', async (t) => {
  const cases: Array<[string, (root: string) => void]> = [
    ['pack compiler input', (root) => {
      const ref = path.join(root, 'contracts/pack_compiler_input.json');
      const input = JSON.parse(fs.readFileSync(ref, 'utf8')) as JsonRecord;
      input.generated_surface_owner = 'target-authority';
      input.domain_repo_can_own_generated_surface = true;
      input.authority_boundary.opl_can_write_domain_truth = true;
      writeJson(root, 'contracts/pack_compiler_input.json', input);
    }],
    ['action catalog', (root) => {
      const ref = path.join(root, 'contracts/action_catalog.json');
      const catalog = JSON.parse(fs.readFileSync(ref, 'utf8')) as JsonRecord;
      catalog.authority_boundary.opl_can_authorize_quality_or_export = true;
      writeJson(root, 'contracts/action_catalog.json', catalog);
    }],
    ['generated surface handoff', (root) => {
      writeJson(root, 'contracts/generated_surface_handoff.json', {
        generated_surface_owner: 'target-authority',
        domain_repo_can_own_generated_surface: true,
        authority_boundary: {
          opl_can_write_domain_truth: true,
        },
      });
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const root = fixture('target-authority');
      mutate(root);
      const readout = buildStandardAgentRepoContractReadout(root);
      assert.equal(readout.status, 'blocked');
    });
  }
});

test('generated-surface handoff defaults preserve legacy contracts and materialize compact deltas', () => {
  const legacy = {
    surface_kind: 'opl_generated_surface_handoff',
    schema_version: 1,
    domain_id: 'legacy-domain',
    generated_surface_owner: 'one-person-lab',
    domain_repo_can_own_generated_surface: false,
    generated_surfaces: [],
    handoff_surfaces: [],
  };
  assert.equal(resolveGeneratedSurfaceHandoffContract(legacy), legacy);

  const resolved = resolveGeneratedSurfaceHandoffContract({
    surface_kind: 'opl_generated_surface_handoff_delta',
    schema_version: 1,
    defaults_profile: STANDARD_GENERATED_SURFACE_HANDOFF_DEFAULTS_PROFILE,
    domain_id: 'compact-domain',
    generated_surface_owner: 'one-person-lab',
    domain_repo_can_own_generated_surface: false,
    generated_surface_overrides: [{
      surface_id: 'product_entry_manifest',
      source_contract: 'contracts/product-registration.json',
    }],
    handoff_surface_overrides: [{
      surface_id: 'domain_handler',
      current_paths: ['runtime/authority_functions/custom.ts'],
    }],
    authority_boundary: {
      generated_surface_can_write_target_truth: false,
    },
  })!;

  assert.equal(resolved.surface_kind, 'opl_generated_surface_handoff');
  assert.equal(resolved.schema_version, 2);
  assert.equal(resolved.generated_surface_owner, 'one-person-lab');
  assert.equal(resolved.domain_repo_can_own_generated_surface, false);
  assert.equal((resolved.generated_surfaces as JsonRecord[]).length, 7);
  assert.equal(
    (resolved.generated_surfaces as JsonRecord[])
      .find((surface) => surface.surface_id === 'product_entry_manifest')
      ?.source_contract,
    'contracts/product-registration.json',
  );
  assert.deepEqual(
    (resolved.handoff_surfaces as JsonRecord[])
      .find((surface) => surface.surface_id === 'domain_handler')
      ?.current_paths,
    ['runtime/authority_functions/custom.ts'],
  );
  assert.equal(
    (resolved.authority_boundary as JsonRecord).generated_surface_can_write_domain_truth,
    false,
  );
  assert.equal(
    (resolved.authority_boundary as JsonRecord).generated_surface_can_write_target_truth,
    false,
  );
});

test('generated-surface handoff defaults expand retired default callers and reject ambiguous deltas', () => {
  const resolved = resolveGeneratedSurfaceHandoffContract({
    surface_kind: 'opl_generated_surface_handoff_delta',
    schema_version: 1,
    defaults_profile: STANDARD_GENERATED_SURFACE_HANDOFF_DEFAULTS_PROFILE,
    agent_id: 'example',
    domain_id: 'example-domain',
    generated_surface_owner: 'one-person-lab',
    domain_repo_can_own_generated_surface: false,
    retired_default_surfaces: [
      { surface_id: 'cli' },
      { surface_id: 'workbench' },
    ],
  })!;
  const surfaces = resolved.handoff_surfaces as JsonRecord[];
  assert.deepEqual(surfaces.map((surface) => surface.surface_id), ['cli', 'workbench']);
  assert.deepEqual(surfaces[0].current_surface_refs, [
    'opl-generated-default-caller:example/cli',
  ]);
  assert.equal(surfaces[1].target_role, 'opl_hosted_surface');
  assert.equal(surfaces[1].source_contract, 'contracts/artifact_locator_contract.json');

  assert.throws(
    () => resolveGeneratedSurfaceHandoffContract({
      surface_kind: 'opl_generated_surface_handoff_delta',
      schema_version: 1,
      defaults_profile: STANDARD_GENERATED_SURFACE_HANDOFF_DEFAULTS_PROFILE,
      domain_id: 'invalid-domain',
      generated_surface_owner: 'one-person-lab',
      domain_repo_can_own_generated_surface: false,
      generated_surfaces: [],
    }),
    (error: unknown) => error instanceof FrameworkContractError
      && error.code === 'contract_shape_invalid',
  );
});

test('hosted generated-surface defaults preserve declared surfaces and reject authority transfer', () => {
  const generatedSurfaceIds = [
    'cli',
    'mcp',
    'skill',
    'product_entry',
    'openai',
    'ai_sdk',
    'status_read_model',
  ];
  const baseDelta = {
    surface_kind: 'opl_generated_surface_handoff_delta',
    schema_version: 1,
    defaults_profile: HOSTED_FOUNDRY_GENERATED_SURFACE_HANDOFF_DEFAULTS_PROFILE,
    domain_id: 'agent-engineering',
    generated_surface_owner: 'one-person-lab',
    domain_repo_can_own_generated_surface: false,
    generated_surface_ids: generatedSurfaceIds,
  };
  const resolved = resolveGeneratedSurfaceHandoffContract(baseDelta)!;

  assert.deepEqual(
    (resolved.generated_surfaces as JsonRecord[]).map((surface) => surface.surface_id),
    generatedSurfaceIds,
  );
  assert.equal((resolved.generated_surfaces as JsonRecord[])[0].owner, 'one-person-lab');
  assert.equal((resolved.handoff_surfaces as JsonRecord[]).length, 7);

  assert.throws(
    () => resolveGeneratedSurfaceHandoffContract({
      ...baseDelta,
      generated_surface_overrides: [{
        surface_id: 'cli',
        owner: 'agent-engineering',
      }],
    }),
    /cannot transfer generated-surface ownership/,
  );
  assert.throws(
    () => resolveGeneratedSurfaceHandoffContract({
      ...baseDelta,
      handoff_surface_overrides: [{
        surface_id: 'domain_handler',
        owner: 'agent-engineering',
      }],
    }),
    /cannot transfer generated-surface ownership/,
  );
  assert.throws(
    () => resolveGeneratedSurfaceHandoffContract({
      ...baseDelta,
      authority_boundary: {
        generated_surface_can_write_target_truth: true,
      },
    }),
    /authority delta cannot grant authority/,
  );
});
