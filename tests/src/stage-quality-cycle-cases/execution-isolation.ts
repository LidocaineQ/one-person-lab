import {
  test,
  assert,
  crypto,
  fs,
  os,
  path,
  DatabaseSync,
  FrameworkContractError,
  buildStageReviewContextManifest,
  classifyCodexSessionContinuation,
  evaluateStageQualityFindingClosure,
  initialStageQualityCycleState,
  normalizeStageQualityArtifactIdentity,
  normalizeStageQualityCyclePolicy,
  reduceStageQualityCycleState,
  stageQualityAttemptOutcomeFromEnvelope,
  STAGE_QUALITY_OUTCOMES,
  validateInitialStageQualityReviewOutcome,
  validateIndependentStageReviewReceipt,
  buildFamilyStageConformanceReview,
  bindStageAttemptExecutionSession,
  createStageAttempt,
  createStageAttemptTable,
  inspectStageAttempt,
  materializePersistedStageReviewReceipt,
  syncStageAttemptFromTemporalTerminalObservation,
  validatePersistedStageReviewIsolation,
  buildCodexStageActivityInput,
  requireTemporalStageRunWorkflowInputLaunchable,
  createStageQualityCycle,
  projectTemporalStageRunQualityCycle,
  requireStageQualityAttemptBoundary,
  buildPackBoundTemporalStageRunInput,
  buildStageQualityContextManifestRef,
  buildStageReviewInputSnapshotContext,
  resolveReviewerInputSnapshotMaterialization,
  OFFICIAL_KNOWLEDGE_DELIVERABLE_QUALITY_PROFILE,
  STANDARD_AGENT_REGISTRY,
  createWorkItemExecutionScopeSnapshot,
  createStageRunLaunchTable,
  buildStageRouteDecisionIdentity,
  normalizeRuntimeExecutionScopeWrite,
  persistRuntimeExecutionScope,
  repoRoot,
  qualityContextBinding,
  persistReviewExecutionScope,
  persistDomainStageRun,
  reviewReceipt,
} from './shared.ts';
import type { StandardAgentStageQualityRuntimeBinding, TemporalStageRunWorkflowState } from './shared.ts';
test('every quality-cycle role launches through a fresh codex exec command', () => {
  for (const role of ['producer', 'reviewer', 'repairer', 're_reviewer'] as const) {
    const reviewRole = role === 'reviewer' || role === 're_reviewer';
    const activity = buildCodexStageActivityInput({
      attempt: {
        stage_attempt_id: `sat_${role}`,
        stage_run_id: 'stage-run:quality-cycle',
        quality_cycle_id: 'quality-cycle:quality-cycle',
        attempt_role: role,
        quality_round_index: role === 're_reviewer' ? 1 : 0,
        stage_id: 'quality-cycle-stage',
        workspace_locator: { workspace_root: '/tmp/quality-cycle' },
        checkpoint_refs: ['packet:quality-cycle'],
        ...(reviewRole
          ? {
              input_artifact_refs: [`artifact:${role}`],
              reviewed_artifact_hashes: [`sha256:${role}`],
              context_manifest_ref: `manifest:${role}`,
              no_context_inheritance: true,
            }
          : {}),
      },
    });
    assert.deepEqual(activity.runner_status.command_preview.slice(0, 2), ['codex', 'exec']);
    assert.equal(activity.runner_status.command_preview[2], '--skip-git-repo-check');
    assert.equal(activity.runner_status.command_preview.includes('resume'), false);
    const prompt = activity.runner_status.command_preview.join('\n');
    if (role === 'producer') {
      assert.match(prompt, /producer is the decisive cross-Stage semantic route selector only when this StageRun is primary-only/);
    }
    if (role === 'repairer') {
      assert.match(prompt, /Do not make a terminal Stage transition decision/);
    }
  }
});

test('persisted reviewer attempt proves separate session and isolated context', () => {
  const db = new DatabaseSync(':memory:');
  try {
    createStageAttemptTable(db);
    const executionScope = persistReviewExecutionScope(db, {
      stageRunId: 'stage-run:rca/artifact-creation',
      stageId: 'artifact_creation',
      workspaceRoot: '/tmp/rca-quality-cycle',
    });
    const shared = {
      domainId: 'redcube_ai' as const,
      stageId: 'artifact_creation',
      providerKind: 'temporal' as const,
      workspaceLocator: { workspace_root: '/tmp/rca-quality-cycle' },
      sourceFingerprint: 'sha256:source',
      stageRunId: 'stage-run:rca/artifact-creation',
      qualityCycleId: 'quality-cycle:rca/artifact-creation',
      qualityRolePromptRef: 'prompt:quality-role',
      qualityRubricRefs: ['rubric:visual'],
      noContextInheritance: true,
      scopeKind: 'work_item' as const,
      executionScope,
    };
    const producer = createStageAttempt(db, {
      ...shared,
      attemptRole: 'producer',
      qualityRoundIndex: 0,
      newAttempt: true,
      ...qualityContextBinding({
        role: 'producer',
        stageRunId: shared.stageRunId,
        qualityCycleId: shared.qualityCycleId,
        rubricRefs: shared.qualityRubricRefs,
      }),
    }).attempt;
    const reviewer = createStageAttempt(db, {
      ...shared,
      attemptRole: 'reviewer',
      qualityRoundIndex: 0,
      parentAttemptRef: `opl://stage_attempts/${producer.stage_attempt_id}`,
      inputArtifactRefs: ['artifact:deck-v1'],
      reviewedArtifactHashes: ['sha256:deck-v1'],
      noContextInheritance: true,
      newAttempt: true,
      ...qualityContextBinding({
        role: 'reviewer',
        stageRunId: shared.stageRunId,
        qualityCycleId: shared.qualityCycleId,
        rubricRefs: shared.qualityRubricRefs,
        artifactRefs: ['artifact:deck-v1'],
        artifactHashes: ['sha256:deck-v1'],
      }),
    }).attempt;
    bindStageAttemptExecutionSession(db, {
      stageAttemptId: producer.stage_attempt_id,
      executionSessionRef: 'codex://threads/producer',
    });
    bindStageAttemptExecutionSession(db, {
      stageAttemptId: reviewer.stage_attempt_id,
      executionSessionRef: 'codex://threads/reviewer',
    });
    db.prepare(`
      UPDATE stage_attempts SET status = 'completed', route_impact_json = ?
      WHERE stage_attempt_id = ?
    `).run(JSON.stringify({
      stage_quality_cycle: {
        artifact_refs: ['artifact:deck-v1'],
        artifact_hashes: ['sha256:deck-v1'],
      },
    }), producer.stage_attempt_id);
    db.prepare(`
      UPDATE stage_attempts SET status = 'completed', route_impact_json = ?
      WHERE stage_attempt_id = ?
    `).run(JSON.stringify({ stage_quality_cycle: { outcome: 'pass', findings: [] } }), reviewer.stage_attempt_id);
    assert.deepEqual(validatePersistedStageReviewIsolation(db, {
      producerAttemptId: producer.stage_attempt_id,
      reviewerAttemptId: reviewer.stage_attempt_id,
      rubricRefs: ['rubric:visual'],
      verdict: 'pass',
    }), {
      valid: true,
      context_isolation_verified: true,
      reviewer_session_diff_verified: true,
    });
  } finally {
    db.close();
  }
});

test('persisted reviewer isolation rejects a shared producer session', () => {
  const db = new DatabaseSync(':memory:');
  try {
    createStageAttemptTable(db);
    const executionScope = persistReviewExecutionScope(db, {
      stageRunId: 'stage-run:rca/artifact-creation',
      stageId: 'artifact_creation',
      workspaceRoot: '/tmp/rca-quality-cycle',
    });
    const shared = {
      domainId: 'redcube_ai' as const,
      stageId: 'artifact_creation',
      providerKind: 'temporal' as const,
      workspaceLocator: { workspace_root: '/tmp/rca-quality-cycle' },
      sourceFingerprint: 'sha256:source',
      stageRunId: 'stage-run:rca/artifact-creation',
      qualityCycleId: 'quality-cycle:rca/artifact-creation',
      newAttempt: true,
      qualityRolePromptRef: 'prompt:quality-role',
      qualityRubricRefs: ['rubric:visual'],
      noContextInheritance: true,
      scopeKind: 'work_item' as const,
      executionScope,
    };
    const producer = createStageAttempt(db, {
      ...shared,
      attemptRole: 'producer',
      ...qualityContextBinding({
        role: 'producer',
        stageRunId: shared.stageRunId,
        qualityCycleId: shared.qualityCycleId,
        rubricRefs: shared.qualityRubricRefs,
      }),
    }).attempt;
    const reviewer = createStageAttempt(db, {
      ...shared,
      attemptRole: 'reviewer',
      parentAttemptRef: `opl://stage_attempts/${producer.stage_attempt_id}`,
      inputArtifactRefs: ['artifact:deck-v1'],
      reviewedArtifactHashes: ['sha256:deck-v1'],
      noContextInheritance: true,
      ...qualityContextBinding({
        role: 'reviewer',
        stageRunId: shared.stageRunId,
        qualityCycleId: shared.qualityCycleId,
        rubricRefs: shared.qualityRubricRefs,
        artifactRefs: ['artifact:deck-v1'],
        artifactHashes: ['sha256:deck-v1'],
      }),
    }).attempt;
    bindStageAttemptExecutionSession(db, {
      stageAttemptId: producer.stage_attempt_id,
      executionSessionRef: 'codex://threads/shared',
    });
    bindStageAttemptExecutionSession(db, {
      stageAttemptId: reviewer.stage_attempt_id,
      executionSessionRef: 'codex://threads/shared',
    });
    db.prepare(`
      UPDATE stage_attempts SET status = 'completed', route_impact_json = ?
      WHERE stage_attempt_id = ?
    `).run(JSON.stringify({
      stage_quality_cycle: {
        artifact_refs: ['artifact:deck-v1'],
        artifact_hashes: ['sha256:deck-v1'],
      },
    }), producer.stage_attempt_id);
    db.prepare(`
      UPDATE stage_attempts SET status = 'completed', route_impact_json = ?
      WHERE stage_attempt_id = ?
    `).run(JSON.stringify({ stage_quality_cycle: { outcome: 'pass', findings: [] } }), reviewer.stage_attempt_id);
    assert.throws(() => validatePersistedStageReviewIsolation(db, {
      producerAttemptId: producer.stage_attempt_id,
      reviewerAttemptId: reviewer.stage_attempt_id,
      rubricRefs: ['rubric:visual'],
      verdict: 'pass',
    }), /new provider session/);
  } finally {
    db.close();
  }
});

test('Temporal terminal sync persists the observed Codex execution session identity', () => {
  const db = new DatabaseSync(':memory:');
  try {
    createStageAttemptTable(db);
    persistDomainStageRun(db, {
      stageRunId: 'stage-run:rca/artifact-creation',
      domainId: 'redcube',
      stageId: 'artifact_creation',
    });
    const attempt = createStageAttempt(db, {
      domainId: 'redcube',
      stageId: 'artifact_creation',
      providerKind: 'temporal',
      workspaceLocator: { workspace_root: '/tmp/rca-quality-cycle' },
      sourceFingerprint: 'sha256:source',
      stageRunId: 'stage-run:rca/artifact-creation',
      qualityCycleId: 'quality-cycle:rca/artifact-creation',
      attemptRole: 'producer',
      qualityRolePromptRef: 'prompt:producer',
      qualityRubricRefs: ['rubric:visual'],
      noContextInheritance: true,
      newAttempt: true,
      ...qualityContextBinding({
        role: 'producer',
        stageRunId: 'stage-run:rca/artifact-creation',
        qualityCycleId: 'quality-cycle:rca/artifact-creation',
        rubricRefs: ['rubric:visual'],
      }),
    }).attempt;
    syncStageAttemptFromTemporalTerminalObservation(db, {
      surface_kind: 'temporal_stage_attempt_query_receipt',
      provider_kind: 'temporal',
      stage_attempt_id: attempt.stage_attempt_id,
      workflow_id: attempt.workflow_id,
      workflow_status: 'COMPLETED',
      query: {
        surface_kind: 'temporal_stage_attempt_query',
        provider_kind: 'temporal',
        stage_attempt_id: attempt.stage_attempt_id,
        workflow_id: attempt.workflow_id,
        domain_id: 'redcube',
        stage_id: 'artifact_creation',
        status: 'blocked',
        activity_events: [{
          activity_kind: 'codex_stage_activity',
          progress_summary: {
            thread_id: 'thread-temporal-producer',
            execution_session_ref: 'codex://threads/thread-temporal-producer',
          },
        }],
        checkpoint_refs: [], closeout_refs: [], consumed_refs: [], consumed_memory_refs: [],
        writeback_receipt_refs: [], rejected_writes: [], route_impact: {}, human_gate_refs: [], signals: [],
        closeout_packet: { blocked_reason: 'typed_closeout_packet_required' },
        completion_boundary: {
          provider_completion: 'not_completed',
          domain_ready_verdict: null,
          provider_completion_is_domain_ready: false,
        },
        authority_boundary: {
          opl: 'temporal_workflow_transport_and_control_metadata_only',
          domain: 'truth_quality_artifact_gate_owner',
        },
      },
    });
    assert.equal(
      inspectStageAttempt(db, attempt.stage_attempt_id).execution_session_ref,
      'codex://threads/thread-temporal-producer',
    );
  } finally {
    db.close();
  }
});

test('reviewer StageAttempt cannot launch without context isolation evidence', () => {
  const db = new DatabaseSync(':memory:');
  try {
    createStageAttemptTable(db);
    persistDomainStageRun(db, {
      stageRunId: 'stage-run:rca/artifact-creation',
      domainId: 'redcube',
      stageId: 'artifact_creation',
    });
    const producer = createStageAttempt(db, {
      domainId: 'redcube',
      stageId: 'artifact_creation',
      providerKind: 'temporal',
      workspaceLocator: { workspace_root: '/tmp/rca-quality-cycle' },
      sourceFingerprint: 'sha256:source',
      stageRunId: 'stage-run:rca/artifact-creation',
      qualityCycleId: 'quality-cycle:rca/artifact-creation',
      attemptRole: 'producer',
      qualityRolePromptRef: 'prompt:producer',
      qualityRubricRefs: ['rubric:visual'],
      noContextInheritance: true,
      newAttempt: true,
      ...qualityContextBinding({
        role: 'producer',
        stageRunId: 'stage-run:rca/artifact-creation',
        qualityCycleId: 'quality-cycle:rca/artifact-creation',
        rubricRefs: ['rubric:visual'],
      }),
    }).attempt;
    assert.throws(() => createStageAttempt(db, {
      domainId: 'redcube',
      stageId: 'artifact_creation',
      providerKind: 'temporal',
      workspaceLocator: { workspace_root: '/tmp/rca-quality-cycle' },
      sourceFingerprint: 'sha256:source',
      stageRunId: 'stage-run:rca/artifact-creation',
      qualityCycleId: 'quality-cycle:rca/artifact-creation',
      attemptRole: 'reviewer',
      parentAttemptRef: `opl://stage_attempts/${producer.stage_attempt_id}`,
      inputArtifactRefs: ['artifact:deck-v1'],
      reviewedArtifactHashes: ['sha256:deck-v1'],
      newAttempt: true,
    }), /fresh isolated context, role prompt, and quality rubric/);
  } finally {
    db.close();
  }
});

test('quality policy defaults to three rounds without making in-thread refinement authoritative', () => {
  const policy = normalizeStageQualityCyclePolicy({
    formal_review: { required: true, risk_tier: 'high' },
  });
  assert.equal(policy.formal_review.max_repair_rounds, 3);
  assert.equal(policy.formal_review.attempt_internal_parallel_review_facets_allowed, true);
  assert.equal(policy.in_thread_refinement.authoritative, false);
});
