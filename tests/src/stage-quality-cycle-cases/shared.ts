import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { FrameworkContractError } from '../../../src/authority/contracts/contracts.ts';
import {
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
} from '../../../src/authority/stages/stage-quality-cycle.ts';

import { buildFamilyStageConformanceReview } from '../../../src/authority/stages/family-stage-conformance.ts';
import {
  bindStageAttemptExecutionSession,
  createStageAttempt,
  createStageAttemptTable,
  inspectStageAttempt,
  materializePersistedStageReviewReceipt,
  syncStageAttemptFromTemporalTerminalObservation,
  validatePersistedStageReviewIsolation,
} from '../../../src/adapters/execution/family-runtime-stage-attempts.ts';
import { buildCodexStageActivityInput } from '../../../src/adapters/execution/family-runtime-codex-stage-runner.ts';
import {
  requireTemporalStageRunWorkflowInputLaunchable,
  type TemporalStageRunWorkflowState,
} from '../../../src/adapters/execution/family-runtime-temporal.ts';
import {
  createStageQualityCycle,
  projectTemporalStageRunQualityCycle,
} from '../../../src/adapters/execution/family-runtime-stage-quality-cycle.ts';
import { requireStageQualityAttemptBoundary } from '../../../src/adapters/execution/family-runtime-stage-quality-attempt-boundary.ts';
import {
  buildPackBoundTemporalStageRunInput,
} from '../../../src/adapters/execution/family-runtime-pack-bound-stage-run.ts';
import type { StandardAgentStageQualityRuntimeBinding } from '../../../src/authority/packages/index.ts';
import {
  buildStageQualityContextManifestRef,
  buildStageReviewInputSnapshotContext,
} from '../../../src/adapters/execution/family-runtime-stage-quality-context-manifest.ts';
import { resolveReviewerInputSnapshotMaterialization } from '../../../src/adapters/execution/family-runtime-reviewer-input-snapshot.ts';
import { OFFICIAL_KNOWLEDGE_DELIVERABLE_QUALITY_PROFILE } from '../../../src/authority/packages/standard-agent-stage-manifest.ts';
import {
  STANDARD_AGENT_REGISTRY,
} from '../../../src/kernel/standard-agent-registry.ts';
import { createWorkItemExecutionScopeSnapshot } from '../../../src/authority/workspace/index.ts';
import { createStageRunLaunchTable } from '../../../src/adapters/execution/family-runtime-stage-run-launch-registry.ts';
import { buildStageRouteDecisionIdentity } from '../../../src/adapters/execution/family-runtime-stage-run-identity.ts';
import {
  normalizeRuntimeExecutionScopeWrite,
  persistRuntimeExecutionScope,
} from '../../../src/adapters/execution/family-runtime-execution-scope-persistence.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function qualityContextBinding(input: {
  role: 'producer' | 'reviewer' | 'repairer' | 're_reviewer';
  stageRunId: string;
  qualityCycleId: string;
  rubricRefs: string[];
  artifactRefs?: string[];
  artifactHashes?: string[];
  priorFindingRefs?: string[];
  repairMapRefs?: string[];
  artifactProducerAttemptRef?: string | null;
}) {
  const artifactIdentity = {
    artifact_refs: input.artifactRefs ?? [],
    artifact_hashes: input.artifactHashes ?? [],
  };
  const contextManifest = input.role === 'reviewer' || input.role === 're_reviewer'
    ? {
        ...buildStageReviewContextManifest({
        stageRunId: input.stageRunId,
        qualityCycleId: input.qualityCycleId,
        reviewerAttemptRole: input.role,
        artifactRefs: artifactIdentity.artifact_refs,
        artifactHashes: artifactIdentity.artifact_hashes,
        qualityRubricRefs: input.rubricRefs,
        priorFindingRefs: input.priorFindingRefs,
        repairMapRefs: input.repairMapRefs,
        }),
        ...buildStageReviewInputSnapshotContext({
          stageRunId: input.stageRunId,
          qualityCycleId: input.qualityCycleId,
          reviewerAttemptRole: input.role,
          resolution: resolveReviewerInputSnapshotMaterialization(null),
        }),
      }
    : {
        surface_kind: 'opl_stage_quality_attempt_context_manifest',
        version: 'stage-quality-attempt-context-manifest.v1',
        stage_run_id: input.stageRunId,
        quality_cycle_id: input.qualityCycleId,
        attempt_role: input.role,
        stage_goal_refs: [],
        source_refs: [],
        lineage_refs: [],
        quality_rubric_refs: input.rubricRefs,
        prior_finding_refs: input.priorFindingRefs ?? [],
        repair_map_refs: input.repairMapRefs ?? [],
        ...artifactIdentity,
        no_context_inheritance: true,
      };
  const boundContextManifest = {
    ...contextManifest,
    ...(input.artifactProducerAttemptRef !== undefined
      ? { artifact_producer_attempt_ref: input.artifactProducerAttemptRef }
      : {}),
  };
  return {
    contextManifest: boundContextManifest,
    contextManifestRef: buildStageQualityContextManifestRef(boundContextManifest),
  };
}

function persistReviewExecutionScope(db: DatabaseSync, input: {
  stageRunId: string;
  stageId: string;
  workspaceRoot: string;
  domainId?: 'redcube' | 'redcube_ai';
  studyId?: string;
}) {
  const domainId = input.domainId ?? 'redcube_ai';
  const studyId = input.studyId ?? 'study-001';
  fs.mkdirSync(path.join(input.workspaceRoot, 'studies', studyId), { recursive: true });
  const executionScope = createWorkItemExecutionScopeSnapshot({
    projectScopeId: 'project:stage-quality-cycle',
    workspaceBindingId: 'binding:stage-quality-cycle',
    domainId,
    workspaceRoot: input.workspaceRoot,
    canonicalWorkItemRoot: path.join(input.workspaceRoot, 'studies', studyId),
    payload: { study_id: studyId },
    requirement: { kind: 'work_item', alias_fields: ['study_id'] },
  });
  const normalized = normalizeRuntimeExecutionScopeWrite({
    domainId,
    scopeKind: 'work_item',
    executionScope,
  });
  persistRuntimeExecutionScope(db, normalized, domainId);
  createStageRunLaunchTable(db);
  const now = new Date().toISOString();
  const stageRunInput = {
    scope_kind: 'work_item',
    execution_scope: executionScope,
    workspace_locator: {
      workspace_root: input.workspaceRoot,
      execution_scope: executionScope,
    },
  };
  db.prepare(`
    INSERT INTO stage_run_launches(
      stage_run_id, stage_run_invocation_id, stage_run_spec_sha256, domain_id, stage_id,
      workflow_id, scope_kind, project_scope_id, work_item_scope_id, workspace_binding_id,
      binding_version_id, scope_digest, execution_scope_json, identity_state,
      stage_run_input_json, launch_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?)
  `).run(
    input.stageRunId,
    `invocation:${input.stageRunId}`,
    `sha256:${'8'.repeat(64)}`,
    domainId,
    input.stageId,
    input.stageRunId.replace(/^stage-run:/, 'workflow:'),
    normalized.columns.scope_kind,
    normalized.columns.project_scope_id,
    normalized.columns.work_item_scope_id,
    normalized.columns.workspace_binding_id,
    normalized.columns.binding_version_id,
    normalized.columns.scope_digest,
    normalized.columns.execution_scope_json,
    normalized.columns.identity_state,
    JSON.stringify(stageRunInput),
    now,
    now,
  );
  return executionScope;
}

function persistDomainStageRun(db: DatabaseSync, input: {
  stageRunId: string;
  domainId: 'redcube' | 'redcube_ai';
  stageId: string;
  workspaceRoot?: string;
}) {
  createStageRunLaunchTable(db);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO stage_run_launches(
      stage_run_id, stage_run_invocation_id, stage_run_spec_sha256, domain_id, stage_id,
      workflow_id, scope_kind, project_scope_id, work_item_scope_id, workspace_binding_id,
      binding_version_id, scope_digest, execution_scope_json, identity_state,
      stage_run_input_json, launch_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'domain', NULL, NULL, NULL, NULL, NULL, NULL, 'resolved', ?, 'registered', ?, ?)
  `).run(
    input.stageRunId,
    `invocation:${input.stageRunId}`,
    `sha256:${'7'.repeat(64)}`,
    input.domainId,
    input.stageId,
    input.stageRunId.replace(/^stage-run:/, 'workflow:'),
    JSON.stringify({
      scope_kind: 'domain',
      workspace_locator: { workspace_root: input.workspaceRoot ?? '/tmp/rca-quality-cycle' },
    }),
    now,
    now,
  );
}


function reviewReceipt(overrides: Record<string, unknown> = {}) {
  return {
    surface_kind: 'opl_stage_review_receipt',
    version: 'stage-review-receipt.v1',
    stage_run_id: 'stage-run:receipt-runtime',
    quality_cycle_id: 'quality-cycle:receipt-runtime',
    producer_attempt_ref: 'opl://stage_attempts/producer',
    reviewer_attempt_ref: 'opl://stage_attempts/reviewer',
    producer_session_ref: 'codex://threads/producer',
    reviewer_session_ref: 'codex://threads/reviewer',
    no_context_inheritance: true,
    reviewed_artifact_refs: ['artifact:reviewed'],
    reviewed_artifact_hashes: ['sha256:reviewed'],
    rubric_refs: ['rubric:quality'],
    verdict: 'pass',
    review_input_snapshot_status: 'quality_debt',
    review_input_snapshot_binding: null,
    opl_reviewer_input_snapshot_manifest_ref: null,
    opl_reviewer_input_snapshot_manifest: null,
    review_input_snapshot_quality_debt_receipt_ref: 'quality-debt:snapshot',
    review_input_snapshot_quality_debt_receipt: {
      surface_kind: 'opl_review_input_snapshot_quality_debt_receipt',
    },
    opl_review_evidence_artifact_receipt_ref: null,
    opl_review_evidence_artifact_receipt: null,
    finding_lineage: {
      review_kind: 'initial_review',
      finding_ids: [],
      findings_sha256: `sha256:${'0'.repeat(64)}`,
      repair_map_sha256: null,
      re_review_result_sha256: null,
    },
    ...overrides,
  } as any;
}


export {
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
};
export type { StandardAgentStageQualityRuntimeBinding, TemporalStageRunWorkflowState };
