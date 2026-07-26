import {
  assert,
  crypto,
  fs,
  os,
  path,
  DatabaseSync,
  test,
  pathToFileURL,
  Worker,
  createWorkItemExecutionScopeSnapshot,
  parseFamilyRuntimeCommand,
  runFamilyRuntime,
  buildPackBoundTemporalStageRunInput,
  resolveStageRunAttemptExecutorContent,
  buildCliStageRunInvocationId,
  buildHostedActionStageRunInvocationId,
  buildRouteStageRunInvocation,
  deriveStageRunId,
  stageAttemptExecutionContentBindingSha256,
  stageRunSpecSha256,
  revalidateStageRunImmutableSpecContent,
  launchRegisteredStageRun,
  materializeStageRunRoute,
  claimStageRunStart,
  findStageRunLaunch,
  inspectStageRunLaunch,
  recordStageRunClosed,
  recordStageRunStartFailure,
  recordStageRunTemporalStart,
  registerStageRunLaunch,
  requireTemporalStageRunWorkflowInputLaunchable,
  stageQualityAttemptMaterializeActivity,
  createStageAttempt,
  createFamilyRuntimeQueueTables,
  openQueueDb,
  normalizeStageQualityCyclePolicy,
  runWithWorkItemFileBoundaryInterlock,
  fixtureRoot,
  domainPackRoot,
  workspaceRoot,
  sha256,
  writeFixture,
  safeIdentityDirectory,
  manifestFixture,
  artifactFixtures,
  binding,
  packageUseBinding,
  workspaceLocator,
  stageRunInput,
  workItemExecutionScope,
  scopedStageRunInput,
  registerStageRunInConfiguredState,
  decisiveExecutionBinding,
  writeTrustedIdentityReceipt,
  temporalStartReceipt,
  workerClaim,
  workerClose,
  waitForBarrierCount,
} from './shared.ts';
test('StageRun creation records incomplete package provenance without blocking execution', () => {
  const useBinding: any = packageUseBinding();
  delete useBinding.root_package.package_version;
  delete useBinding.root_package.package_lock_ref;
  delete useBinding.root_package.manifest_sha256;
  delete useBinding.root_package.content_digest;
  delete useBinding.provider_packages[0].manifest_sha256;
  delete useBinding.provider_packages[0].content_digest;
  delete useBinding.dependency_closure_digest;
  const stageRun = stageRunInput({
    invocationId: 'sri_incomplete_package_provenance',
    locator: workspaceLocator(useBinding),
  });
  const closure = stageRun.stage_run_spec.package_closure as any;
  assert.equal(closure.root_package.package_id, 'mas');
  assert.equal(closure.root_package.package_version, null);
  assert.equal(closure.root_package.package_lock_ref, null);
  assert.equal(closure.root_package.manifest_sha256, null);
  assert.equal(closure.root_package.content_digest, null);
  assert.equal(closure.provider_packages[0].package_id, 'mas-scholar-skills');
  assert.equal(closure.provider_packages[0].manifest_sha256, null);
  assert.equal(closure.provider_packages[0].content_digest, null);
  assert.equal(closure.dependency_closure_digest, null);
});

test('StageRun creation still rejects a malformed package provenance digest when present', () => {
  const useBinding: any = packageUseBinding();
  useBinding.root_package.content_digest = 'not-a-sha256';
  assert.throws(() => stageRunInput({
    invocationId: 'sri_invalid_root_content_digest',
    locator: workspaceLocator(useBinding),
  }), (error: any) => {
    assert.equal(error.details?.failure_code, 'stage_run_content_digest_invalid');
    return true;
  });
});

test('one invocation rejects immutable spec drift and preserves the original registered input', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const first = stageRunInput();
    const registered = registerStageRunLaunch(db, first);
    assert.equal(registered.registered, true);
    const volatileReplay = {
      ...first,
      workspace_locator: {
        ...first.workspace_locator,
        checkout_currentness: { status: 'current', checked_at: '2026-07-14T02:00:00.000Z' },
      },
    };
    const replayed = registerStageRunLaunch(db, volatileReplay);
    assert.equal(replayed.idempotent_replay, true);
    assert.deepEqual(replayed.launch.stage_run_input, first);

    const drift = stageRunInput({ sourceFingerprint: `sha256:${'8'.repeat(64)}` });
    assert.throws(() => registerStageRunLaunch(db, drift), (error: any) => {
      assert.equal(error.details?.failure_code, 'stage_run_invocation_spec_conflict');
      return true;
    });
    assert.equal(inspectStageRunLaunch(db, first.stage_run_id).stage_run_spec_sha256,
      first.stage_run_spec_sha256);
  } finally {
    db.close();
  }
});

test('StageRun and StageAttempt persist one exact work-item execution scope', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    createFamilyRuntimeQueueTables(db);
    const scope = workItemExecutionScope();
    fs.mkdirSync(scope.canonical_work_item_root!, { recursive: true });
    const scopedArtifact = writeFixture(
      scope.canonical_work_item_root!,
      'artifacts/request.json',
      '{"artifact_id":"scoped-request"}\n',
    );
    const input = stageRunInput({
      invocationId: 'sri_execution_scope_binding',
      executionScope: scope,
      artifact: {
        ref: pathToFileURL(scopedArtifact.filePath).href,
        sha256: scopedArtifact.sha256,
      },
    });
    assert.throws(() => registerStageRunLaunch(db, input, {
      scopeKind: 'work_item',
    }), (error: any) => {
      assert.equal(error.details?.failure_code, 'work_item_execution_scope_missing');
      return true;
    });

    const registered = registerStageRunLaunch(db, input, {
      scopeKind: 'work_item',
      executionScope: scope,
    });
    assert.equal(registered.launch.scope_kind, 'work_item');
    assert.equal(registered.launch.identity_state, 'resolved');
    assert.equal(registered.launch.work_item_scope_id, scope.work_item_scope_id);
    assert.equal(registered.launch.scope_digest, scope.scope_digest);
    assert.deepEqual(registered.launch.execution_scope, scope);

    const replayed = registerStageRunLaunch(db, input, {
      scopeKind: 'work_item',
      executionScope: scope,
    });
    assert.equal(replayed.idempotent_replay, true);
    assert.throws(() => registerStageRunLaunch(db, input, {
      scopeKind: 'work_item',
      executionScope: workItemExecutionScope('study-002'),
    }), (error: any) => {
      assert.equal(error.details?.failure_code, 'runtime_execution_scope_conflict');
      return true;
    });

    const attempt = createStageAttempt(db, {
      domainId: 'medautoscience',
      stageId: 'intake',
      providerKind: 'temporal',
      workspaceLocator: { workspace_root: workspaceRoot, study_id: 'study-001' },
      sourceFingerprint: 'scope-attempt-one',
      stageRunId: input.stage_run_id,
      scopeKind: 'work_item',
      executionScope: scope,
    }).attempt;
    assert.equal(attempt.stage_run_id, input.stage_run_id);
    assert.equal(attempt.scope_kind, 'work_item');
    assert.equal(attempt.identity_state, 'resolved');
    assert.equal(attempt.scope_digest, scope.scope_digest);
    assert.deepEqual(attempt.execution_scope, scope);

    assert.throws(() => createStageAttempt(db, {
      domainId: 'medautoscience',
      stageId: 'intake',
      providerKind: 'temporal',
      workspaceLocator: { workspace_root: workspaceRoot, study_id: 'study-001' },
      sourceFingerprint: 'scope-attempt-missing-stage-run',
      scopeKind: 'work_item',
      executionScope: scope,
    }), (error: any) => {
      assert.equal(error.details?.failure_code, 'work_item_stage_attempt_stage_run_missing');
      return true;
    });

    assert.throws(() => createStageAttempt(db, {
      domainId: 'medautoscience',
      stageId: 'intake',
      providerKind: 'temporal',
      workspaceLocator: { workspace_root: workspaceRoot, study_id: 'study-002' },
      sourceFingerprint: 'scope-attempt-cross-study',
      stageRunId: input.stage_run_id,
      scopeKind: 'work_item',
      executionScope: workItemExecutionScope('study-002'),
    }), (error: any) => {
      assert.equal(error.details?.failure_code, 'stage_attempt_stage_run_scope_mismatch');
      return true;
    });

    const domainAttempt = createStageAttempt(db, {
      domainId: 'medautoscience',
      stageId: 'runtime-maintenance',
      providerKind: 'temporal',
      workspaceLocator: { workspace_root: workspaceRoot, study_id: 'legacy-display-only' },
      sourceFingerprint: 'domain-scope-attempt',
      scopeKind: 'domain',
    }).attempt;
    assert.equal(domainAttempt.scope_kind, 'domain');
    assert.equal(domainAttempt.identity_state, 'resolved');
    assert.equal(domainAttempt.execution_scope, null);
    assert.equal(domainAttempt.stage_run_id, null);
  } finally {
    db.close();
  }
});

test('scoped StageRun registration treats active unresolved runtime aliases as negative-only conflicts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    createFamilyRuntimeQueueTables(db);
    const legacyAttempt = createStageAttempt(db, {
      domainId: 'medautoscience',
      stageId: 'intake',
      providerKind: 'temporal',
      workspaceLocator: { workspace_root: workspaceRoot, study_id: 'study-001' },
      sourceFingerprint: 'sha256:legacy-unresolved-attempt',
      scopeKind: 'domain',
    }).attempt;
    db.prepare(`
      UPDATE stage_attempts
      SET status = 'running', scope_kind = 'identity_unresolved', identity_state = 'identity_unresolved'
      WHERE stage_attempt_id = ?
    `).run(legacyAttempt.stage_attempt_id);

    const legacyStageRun = stageRunInput({ invocationId: 'sri_legacy_unresolved_release' });
    registerStageRunLaunch(db, legacyStageRun);
    db.prepare(`
      UPDATE stage_run_launches
      SET launch_status = 'started', scope_kind = 'identity_unresolved', identity_state = 'identity_unresolved'
      WHERE stage_run_id = ?
    `).run(legacyStageRun.stage_run_id);

    const candidate = scopedStageRunInput('sri_scoped_release_candidate', 'study-002');
    assert.throws(() => registerStageRunLaunch(db, candidate.input, {
      scopeKind: 'work_item',
      executionScope: candidate.scope,
    }), (error: any) => {
      assert.equal(error.details?.failure_code, 'active_unresolved_runtime_identity_conflict');
      assert.equal(error.details?.legacy_alias_policy, 'negative_admission_only');
      assert.equal(error.details?.positive_binding_allowed, false);
      assert.deepEqual(
        new Set(error.details?.legacy_conflicts.map((entry: any) => entry.runtime_kind)),
        new Set(['stage_attempt', 'stage_run']),
      );
      assert.equal(
        error.details?.legacy_conflicts.every((entry: any) => entry.workspace_match === 'same_workspace'),
        true,
      );
      return true;
    });
    assert.equal(findStageRunLaunch(db, candidate.input.stage_run_id), null);
    assert.equal(
      db.prepare('SELECT status FROM stage_attempts WHERE stage_attempt_id = ?')
        .get(legacyAttempt.stage_attempt_id)?.status,
      'running',
    );

    db.prepare("UPDATE stage_attempts SET status = 'completed' WHERE stage_attempt_id = ?")
      .run(legacyAttempt.stage_attempt_id);
    db.prepare("UPDATE stage_run_launches SET launch_status = 'closed' WHERE stage_run_id = ?")
      .run(legacyStageRun.stage_run_id);
    assert.equal(registerStageRunLaunch(db, candidate.input, {
      scopeKind: 'work_item',
      executionScope: candidate.scope,
    }).registered, true);
  } finally {
    db.close();
  }
});

test('pre-registered scoped work cannot start or materialize after an unresolved legacy conflict appears', () => {
  const db = new DatabaseSync(':memory:');
  try {
    createFamilyRuntimeQueueTables(db);
    const candidate = scopedStageRunInput('sri_scoped_release_claim', 'study-002');
    registerStageRunLaunch(db, candidate.input, {
      scopeKind: 'work_item',
      executionScope: candidate.scope,
    });
    const legacyAttempt = createStageAttempt(db, {
      domainId: 'medautoscience',
      stageId: 'intake',
      providerKind: 'temporal',
      workspaceLocator: { workspace_root: workspaceRoot, study_id: 'study-001' },
      sourceFingerprint: 'sha256:legacy-unresolved-after-registration',
      scopeKind: 'domain',
    }).attempt;
    db.prepare(`
      UPDATE stage_attempts
      SET status = 'running', scope_kind = 'identity_unresolved', identity_state = 'identity_unresolved'
      WHERE stage_attempt_id = ?
    `).run(legacyAttempt.stage_attempt_id);

    for (const operation of [
      () => claimStageRunStart(db, { stageRunId: candidate.input.stage_run_id }),
      () => createStageAttempt(db, {
        domainId: 'medautoscience',
        stageId: 'intake',
        providerKind: 'temporal',
        workspaceLocator: candidate.input.workspace_locator,
        sourceFingerprint: 'sha256:scoped-attempt-after-legacy-conflict',
        stageRunId: candidate.input.stage_run_id,
        scopeKind: 'work_item',
        executionScope: candidate.scope,
      }),
    ]) {
      assert.throws(operation, (error: any) => {
        assert.equal(error.details?.failure_code, 'active_unresolved_runtime_identity_conflict');
        return true;
      });
    }
    assert.equal(inspectStageRunLaunch(db, candidate.input.stage_run_id).launch_status, 'registered');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM stage_attempts WHERE scope_kind = ?')
        .get('work_item')?.count,
      0,
    );
  } finally {
    db.close();
  }
});

test('registry validates exact input before write and start receipt cannot reopen a closed Run', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const input = stageRunInput({ invocationId: 'sri_registry_validation' });
    assert.throws(() => registerStageRunLaunch(db, {
      ...input,
      stage_run_id: 'sr_tampered_before_write',
    }), (error: any) => {
      assert.equal(error.details?.failure_code, 'stage_run_identity_mismatch');
      return true;
    });
    const table = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage_run_launches'
    `).get();
    assert.equal(table, undefined);

    registerStageRunLaunch(db, input);
    recordStageRunTemporalStart(db, {
      stageRunId: input.stage_run_id,
      temporalStartReceipt: temporalStartReceipt(input),
    });
    recordStageRunClosed(db, { stageRunId: input.stage_run_id, terminalStatus: 'completed' });
    const afterLateStartReceipt = recordStageRunTemporalStart(db, {
      stageRunId: input.stage_run_id,
      temporalStartReceipt: {
        workflow_id: input.workflow_id,
        first_execution_run_id: `run-${input.stage_run_id}`,
        workflow_status: 'RUNNING',
      },
    });
    assert.equal(afterLateStartReceipt.launch_status, 'closed');
    assert.equal(afterLateStartReceipt.terminal_status, 'completed');
    assert.equal(afterLateStartReceipt.temporal_start_receipt?.workflow_status, 'RUNNING');
  } finally {
    db.close();
  }
});

test('legacy identity-unresolved StageRun cannot launch or recover from historical input', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const current = stageRunInput({ invocationId: 'sri_legacy_identity_unresolved' });
    const legacy = { ...current } as Record<string, unknown>;
    delete legacy.scope_kind;
    delete legacy.execution_scope;
    registerStageRunLaunch(db, legacy as unknown as ReturnType<typeof stageRunInput>);
    db.prepare(`
      UPDATE stage_run_launches
      SET scope_kind = 'identity_unresolved', identity_state = 'identity_unresolved'
      WHERE stage_run_id = ?
    `).run(current.stage_run_id);
    await assert.rejects(() => launchRegisteredStageRun({
      db,
      stageRunInput: legacy as unknown as ReturnType<typeof stageRunInput>,
      start: false,
      startWorkflow: async () => ({ workflow_status: 'RUNNING' }),
    }), (error: any) => {
      assert.equal(error.details?.failure_code, 'runtime_execution_identity_unresolved');
      return true;
    });
  } finally {
    db.close();
  }
});

test('StageRun launch validation rejects id and envelope drift', () => {
  const input = stageRunInput();
  assert.equal(requireTemporalStageRunWorkflowInputLaunchable(input), input);
  assert.throws(() => requireTemporalStageRunWorkflowInputLaunchable({
    ...input,
    stage_run_id: 'sr_tampered',
  }), (error: any) => {
    assert.equal(error.details?.failure_code, 'stage_run_identity_mismatch');
    return true;
  });
  assert.throws(() => requireTemporalStageRunWorkflowInputLaunchable({
    ...input,
    workspace_locator: { ...input.workspace_locator, workspace_root: '/tmp/wrong-target' },
  }), (error: any) => {
    assert.equal(error.details?.failure_code, 'stage_run_spec_envelope_mismatch');
    return true;
  });
});

test('CLI parser exposes explicit new StageRun and exact input artifact identity', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-stage-run-parser-state-'));
  const familyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-stage-run-parser-family-'));
  const previousStateRoot = process.env.OPL_STATE_DIR;
  const previousFamilyRoot = process.env.OPL_FAMILY_WORKSPACE_ROOT;
  try {
    process.env.OPL_STATE_DIR = stateRoot;
    process.env.OPL_FAMILY_WORKSPACE_ROOT = familyRoot;
    const parsed = parseFamilyRuntimeCommand([
      'attempt', 'create', '--domain', 'medautoscience', '--stage', 'intake',
      '--workspace-locator', JSON.stringify({ workspace_root: '/tmp/workspace' }),
      '--new-stage-run',
      '--input-artifact-ref', 'artifact:request',
      '--input-artifact-sha256', 'sha256:request',
    ]);
    assert.equal(parsed.mode, 'attempt_create');
    if (parsed.mode !== 'attempt_create') assert.fail('expected attempt_create');
    assert.equal(parsed.input.newStageRun, true);
    assert.deepEqual(parsed.input.inputArtifactRefs, ['artifact:request']);
    assert.deepEqual(parsed.input.inputArtifactHashes, ['sha256:request']);
  } finally {
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    if (previousFamilyRoot === undefined) delete process.env.OPL_FAMILY_WORKSPACE_ROOT;
    else process.env.OPL_FAMILY_WORKSPACE_ROOT = previousFamilyRoot;
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(familyRoot, { recursive: true, force: true });
  }
});
