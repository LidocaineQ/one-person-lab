import {
  assert,
  fs,
  os,
  parseJsonText,
  path,
  runCli,
  runCliFailure,
  test,
} from '../../helpers.ts';

function readJsonFile(filePath: string) {
  return parseJsonText(fs.readFileSync(filePath, 'utf8')) as any;
}

function writeJson(filePath: string, payload: object) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function standardAgentInterface(domainId: string, agentId: string) {
  return {
    version: 'opl_standard_agent_interface.v1',
    workspace_binding: {
      locator_surface_kind: `opl_${agentId}_workspace_locator`,
      default_profile_id: 'one_off',
      workspace_kind: `${agentId}_workspace`,
      project_kind: 'project',
      project_collection_label: 'projects',
      default_workspace_id: `${agentId}-workspace`,
      default_project_id: `${agentId}-001`,
      required_locator_fields: [],
      optional_locator_fields: ['workspace_root', 'profile_ref'],
    },
    runtime: {
      runtime_domain_id: domainId,
      registration_ref: null,
    },
    progress: {
      deliverable_delta_aliases: [],
      platform_delta_aliases: [],
    },
    routing: {
      explicit_aliases: [agentId],
      workstream_ids: [domainId],
      intent_signals: [`${agentId}_work`],
      ambiguity_policy: 'require_explicit_agent_intent',
    },
  };
}

function actionCatalog(requiredFields = ['source_refs']) {
  return {
    surface_kind: 'family_action_catalog',
    version: 'family-action-catalog.v2',
    catalog_id: 'oma_action_catalog',
    target_domain_id: 'agent_engineering',
    owner: 'oma',
    authority_boundary: {
      domain_truth_owner: 'oma',
      opl_role: 'foundry_runtime_owner',
      write_policy: 'no_domain_truth_writes',
      opl_can_write_domain_truth: false,
    },
    actions: [{
      action_id: 'engineer-agent',
      title: 'Engineer Agent',
      summary: 'Consume source refs through the declared public action.',
      owner: 'oma',
      effect: 'mutating',
      execution_binding: {
        kind: 'foundry_binding',
        provider_manifest_ref: 'contracts/foundry_provider.json',
      },
      input_schema_ref: 'opl://foundry-protocol/DesignRequest',
      output_schema_ref: 'opl://foundry-control/FoundryRun',
      required_fields: requiredFields,
      optional_fields: [],
      workspace_locator_fields: [],
      human_gate_ids: [],
      supported_surfaces: {
        cli: {},
        mcp: { tool_name: 'oma_engineer_agent' },
        skill: { command_contract_id: 'oma.engineer-agent' },
        product_entry: { action_key: 'engineer-agent' },
        openai: { tool_name: 'oma_engineer_agent' },
        ai_sdk: { tool_name: 'oma_engineer_agent' },
      },
      authority_boundary: {
        oma_can_write_target_domain_truth: false,
        opl_can_write_target_domain_truth: false,
      },
    }],
    notes: [],
  };
}

function sourceMaterialFixture(agentId: 'oma' | 'obf' = 'oma') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `opl-source-material-${agentId}-`));
  const stateRoot = path.join(root, 'state');
  const familyRoot = path.join(root, 'family');
  const workspaceRoot = path.join(root, 'workspaces');
  const sourceRoot = path.join(root, 'source');
  const project = agentId === 'oma' ? 'opl-meta-agent' : 'opl-bookforge';
  const domainId = agentId === 'oma' ? 'agent_engineering' : 'opl-bookforge';
  const repoDir = path.join(familyRoot, project);
  const descriptor = {
    surface_kind: 'domain_agent_descriptor',
    schema_version: 1,
    kind: 'agent',
    agent_id: agentId,
    package_id: agentId,
    domain_id: domainId,
    domain_label: agentId.toUpperCase(),
    standard_agent_interface: standardAgentInterface(domainId, agentId),
    ...(agentId === 'oma'
      ? {
          public_action_ids: ['engineer-agent'],
          action_catalog_ref: 'contracts/action_catalog.json',
          source_material_consumer: {
            version: 'opl_source_material_consumer_projection.v1',
            role_bindings: {
              reference_design: {
                applicability: 'required',
                public_action_id: 'engineer-agent',
                request_ref_field: 'source_refs',
              },
            },
            provider_execution_at_ingest: 'not_applicable',
          },
          standard_contract_refs: {
            action_catalog: 'contracts/action_catalog.json',
            foundry_provider: 'contracts/foundry_provider.json',
          },
        }
      : {}),
  };
  writeJson(path.join(repoDir, 'contracts/domain_descriptor.json'), descriptor);
  if (agentId === 'oma') {
    writeJson(path.join(repoDir, 'contracts/action_catalog.json'), actionCatalog());
    writeJson(path.join(repoDir, 'contracts/foundry_provider.json'), {
      surface_kind: 'opl_foundry_provider',
      version: 'opl-foundry-provider.v1',
      provider_id: 'oma',
      agent_id: 'oma',
      package_id: 'oma',
      domain_id: 'agent_engineering',
    });
  }
  fs.mkdirSync(sourceRoot, { recursive: true });
  const inputFile = path.join(sourceRoot, 'HemaGuide.pdf');
  fs.writeFileSync(inputFile, '%PDF-1.4 reference design\n');
  const env = {
    OPL_STATE_DIR: stateRoot,
    OPL_FAMILY_WORKSPACE_ROOT: familyRoot,
  };
  runCli([
    'workspace',
    'init',
    '--agent',
    agentId,
    '--workspace-root',
    workspaceRoot,
    '--workspace-id',
    `${agentId}-workspace`,
    '--project-id',
    `${agentId}-project`,
  ], env);
  return {
    root,
    repoDir,
    workspacePath: path.join(workspaceRoot, `${agentId}-workspace`),
    inputFile,
    env,
  };
}

function ingestArgs(fixture: ReturnType<typeof sourceMaterialFixture>, role = 'reference_design') {
  return [
    'workspace',
    'source',
    'ingest',
    '--workspace',
    fixture.workspacePath,
    '--project-id',
    path.basename(fixture.workspacePath).replace('-workspace', '-project'),
    '--file',
    fixture.inputFile,
    '--role',
    role,
  ];
}

test('workspace source ingest derives an OMA refs-only route without executing its provider', () => {
  const fixture = sourceMaterialFixture('oma');
  try {
    const output = runCli(ingestArgs(fixture), fixture.env);
    const ingest = output.workspace_source_ingest;
    assert.equal(ingest.status, 'applied');
    assert.equal(ingest.source_material_role, 'reference_design');
    assert.equal(ingest.original_file.mime_type, 'application/pdf');
    assert.equal(ingest.source_fingerprint_ref, `sha256:${ingest.original_file.sha256}`);
    assert.deepEqual(ingest.reference_design_pattern_handoff, {
      applicability: 'required',
      contract_ref:
        'contracts/opl-framework/source-material-ingest-contract.json#/handoff_policy/reference_design_pattern_handoff',
      source_material_role: 'reference_design',
      consumer_projection_ref:
        'contracts/domain_descriptor.json#/source_material_consumer/role_bindings/reference_design',
      consumer_route: {
        consumer_agent_id: 'oma',
        public_action_id: 'engineer-agent',
        action_catalog_ref: 'contracts/action_catalog.json',
        input_schema_ref: 'opl://foundry-protocol/DesignRequest',
        request_ref_field: 'source_refs',
        provider_manifest_ref: 'contracts/foundry_provider.json',
        provider_id: 'oma',
      },
      semantic_extraction_executed: false,
      provider_execution_at_ingest: 'not_applicable',
      reason: null,
      authority_boundary: {
        refs_only: true,
        body_free: true,
        opl_can_extract_source_semantics: false,
        opl_can_write_domain_truth: false,
        opl_can_copy_source_body_into_contract: false,
        opl_can_sign_owner_receipt: false,
        opl_can_create_typed_blocker: false,
        opl_can_claim_pattern_quality_ready: false,
        opl_can_claim_target_ready: false,
        opl_can_claim_domain_ready: false,
        opl_can_claim_production_ready: false,
      },
    });
    assert.equal(ingest.extraction_policy.provider_execution_at_ingest, 'not_applicable');
    assert.equal(ingest.extraction_policy.extraction_owner, 'oma');
    assert.equal(fs.statSync(ingest.stored_file.path).isFile(), true);
    const receipt = readJsonFile(ingest.receipt_path);
    assert.deepEqual(receipt.reference_design_pattern_handoff, ingest.reference_design_pattern_handoff);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('workspace source ingest marks undeclared roles and non-consumer Agents not applicable', () => {
  const omaFixture = sourceMaterialFixture('oma');
  const obfFixture = sourceMaterialFixture('obf');
  try {
    const undeclaredRole = runCli([...ingestArgs(omaFixture, 'dataset'), '--dry-run'], omaFixture.env)
      .workspace_source_ingest.reference_design_pattern_handoff;
    assert.deepEqual(undeclaredRole, {
      applicability: 'not_applicable',
      contract_ref:
        'contracts/opl-framework/source-material-ingest-contract.json#/handoff_policy/reference_design_pattern_handoff',
      source_material_role: 'dataset',
      consumer_projection_ref: 'contracts/domain_descriptor.json#/source_material_consumer',
      consumer_route: null,
      semantic_extraction_executed: false,
      provider_execution_at_ingest: 'not_applicable',
      reason: 'source_material_role_not_declared',
      authority_boundary: undeclaredRole.authority_boundary,
    });
    const nonConsumer = runCli([...ingestArgs(obfFixture), '--dry-run'], obfFixture.env)
      .workspace_source_ingest.reference_design_pattern_handoff;
    assert.equal(nonConsumer.applicability, 'not_applicable');
    assert.equal(nonConsumer.consumer_projection_ref, null);
    assert.equal(nonConsumer.consumer_route, null);
    assert.equal(nonConsumer.reason, 'source_material_role_not_declared');
    assert.equal(nonConsumer.provider_execution_at_ingest, 'not_applicable');
  } finally {
    fs.rmSync(omaFixture.root, { recursive: true, force: true });
    fs.rmSync(obfFixture.root, { recursive: true, force: true });
  }
});

test('workspace source ingest still copies and hashes when the consumer descriptor is unavailable', () => {
  const fixture = sourceMaterialFixture('oma');
  try {
    fs.rmSync(path.join(fixture.repoDir, 'contracts/domain_descriptor.json'));
    const ingest = runCli(ingestArgs(fixture), fixture.env).workspace_source_ingest;
    assert.equal(ingest.status, 'applied');
    assert.equal(ingest.source_material_ref, `source-material:sha256:${ingest.original_file.sha256}`);
    assert.equal(fs.statSync(ingest.stored_file.path).isFile(), true);
    assert.equal(fs.statSync(ingest.receipt_path).isFile(), true);
    assert.equal(ingest.reference_design_pattern_handoff.applicability, 'not_applicable');
    assert.equal(ingest.reference_design_pattern_handoff.consumer_route, null);
    assert.equal(
      ingest.reference_design_pattern_handoff.reason,
      'consumer_descriptor_unavailable',
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('workspace source ingest blocks an explicitly inconsistent action/provider linkage', () => {
  const fixture = sourceMaterialFixture('oma');
  try {
    writeJson(
      path.join(fixture.repoDir, 'contracts/action_catalog.json'),
      actionCatalog(['objective']),
    );
    const failure = runCliFailure(ingestArgs(fixture), fixture.env);
    assert.equal(failure.payload.error.code, 'contract_shape_invalid');
    assert.match(failure.payload.error.message, /request ref field is not declared/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
