import assert from 'node:assert/strict';
import crypto, { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { parseJsonText } from '../../../src/kernel/json-file.ts';
import { record } from '../../../src/kernel/json-record.ts';
import {
  parseStandardAgentInterface,
  STANDARD_AGENT_INTERFACE_VERSION,
  type StandardAgentDescriptorInterface,
} from '../../../src/kernel/standard-agent-interface.ts';
import { validateJsonSchemaPayload } from '../../../src/kernel/schema-registry.ts';
import { buildAgentCatalog } from '../../../src/read-models/operator/work-item-projection/catalog.ts';
import {
  joinAttemptsToWorkItems,
  readWorkItemStageAttemptsFromDb,
} from '../../../src/read-models/operator/work-item-projection/execution.ts';
import { buildAppRuntimeWorkItemProjection } from '../../../src/read-models/operator/app-runtime-work-item-projection.ts';
import { readStageIndexPresentation } from '../../../src/read-models/operator/work-item-projection/inventory-presentation.ts';
import { readWorkItemStageAttempts } from '../../../src/read-models/operator/work-item-projection/execution.ts';
import { projectRuntimeActivityItems } from '../../../src/read-models/operator/work-item-projection/runtime-activity-projection.ts';
import { buildWorkItemProjectionV2 } from '../../../src/read-models/operator/work-item-projection/projection.ts';
import { projectWorkItemPrimaryState } from '../../../src/read-models/operator/work-item-projection/primary-state.ts';
import { buildStageAttemptRuntimeCurrentness } from '../../../src/adapters/execution/family-runtime-stage-attempt-runtime-currentness.ts';
import { createStageAttemptTable } from '../../../src/adapters/execution/family-runtime-stage-attempt-ledger.ts';
import {
  normalizeRuntimeExecutionScopeWrite,
  persistRuntimeExecutionScope,
} from '../../../src/adapters/execution/family-runtime-execution-scope-persistence.ts';
import { createStageRunLaunchTable } from '../../../src/adapters/execution/family-runtime-stage-run-launch-registry.ts';
import {
  setWorkItemControlState,
  setWorkItemVisibilityState,
} from '../../../src/authority/evidence/work-item-control-ledger.ts';
import type { WorkspaceBinding } from '../../../src/authority/workspace/workspace-registry.ts';
import { createWorkItemExecutionScopeSnapshot } from '../../../src/authority/workspace/public/standard-agent-action-runtime.ts';

const MAS_STUDIES = {
  Diabetes: [
    ['001-dm-cvd-mortality-risk', 'CVD mortality risk', 'active'],
    ['002-dm-china-us-mortality-attribution', 'China-US mortality attribution', 'delivered_paused'],
    ['003-dpcc-primary-care-phenotype-treatment-gap', 'Primary-care phenotype treatment gap', 'delivered_paused'],
    ['004-dpcc-longitudinal-care-inertia-intensification-gap', 'Longitudinal care inertia', 'paused'],
  ],
  'NF-PitNET': [
    ['001-lineage-pfs', 'Lineage and progression-free survival', 'stopped'],
    ['002-early-residual-risk', 'Early residual risk', 'delivered_paused'],
    ['003-endocrine-burden-followup', 'Endocrine burden follow-up', 'delivered_paused'],
    ['004-invasive-architecture', 'Invasive architecture', 'stopped'],
  ],
  Obesity: [
    ['obesity_multicenter_phenotype_atlas', 'Multicenter obesity phenotype atlas', 'active'],
  ],
} as const;

function masDescriptor(): StandardAgentDescriptorInterface {
  return {
    repo_dir: '/fixture/med-autoscience',
    kind: 'agent',
    agent_id: 'mas',
    package_id: 'mas',
    domain_id: 'medautoscience',
    display_name: 'Med Auto Science',
    interface: parseStandardAgentInterface({
      version: STANDARD_AGENT_INTERFACE_VERSION,
      inventory_projection: {
        source_kind: 'workspace_relative_json',
        relative_path: 'workspace_index.json',
        items_pointer: '/studies',
        field_map: {
          display_name: 'display_name',
          next_action: 'next_action',
          stage_index_ref: 'stage_index_ref',
          work_item_id: 'study_id',
          work_item_root: 'canonical_study_root',
          business_status: 'status',
          current_stage_id: 'current_stage_id',
          current_stage_status: 'current_stage_status',
          package_status: 'package_status',
          lifecycle_ref: 'study_status_ref',
        },
      },
      workspace_binding: {
        locator_surface_kind: 'med_autoscience_workspace_profile',
        default_profile_id: 'portfolio',
        workspace_kind: 'medical_research_workspace',
        project_kind: 'study',
        project_collection_label: 'studies',
        default_workspace_id: 'research-workspace',
        default_project_id: 'study-001',
        required_locator_fields: ['workspace_root'],
        optional_locator_fields: [],
      },
      runtime: {
        runtime_domain_id: 'medautoscience',
        registration_ref: 'contracts/domain_route_profile.json',
      },
      progress: { deliverable_delta_aliases: [], platform_delta_aliases: [] },
      routing: {
        explicit_aliases: ['mas', 'medautoscience', 'med-autoscience'],
        workstream_ids: ['medical_research'],
        intent_signals: ['medical research'],
        ambiguity_policy: 'require_explicit_domain_selection',
      },
    }, 'fixture:mas#/standard_agent_interface'),
  };
}

function identityDescriptor(agentId: string): StandardAgentDescriptorInterface {
  return {
    repo_dir: `/fixture/${agentId}`,
    kind: 'agent',
    agent_id: agentId,
    package_id: agentId,
    domain_id: `${agentId}-domain`,
    display_name: `${agentId.toUpperCase()} Agent`,
    interface: {
      ...masDescriptor().interface,
      inventory_projection: null,
      stage_catalog: null,
      domain_detail_views: [],
      runtime: { runtime_domain_id: `${agentId}-domain`, registration_ref: null },
      routing: {
        explicit_aliases: [agentId, `${agentId}-domain`],
        workstream_ids: [],
        intent_signals: [],
        ambiguity_policy: 'require_explicit_domain_selection',
      },
    },
  };
}

function writeWorkspace(root: string, label: keyof typeof MAS_STUDIES) {
  fs.mkdirSync(root, { recursive: true });
  const studies = MAS_STUDIES[label].map(([studyId, displayName, status]) => {
    const studyRoot = path.join(root, 'studies', studyId);
    const controlRoot = path.join(studyRoot, 'control');
    fs.mkdirSync(controlRoot, { recursive: true });
    fs.writeFileSync(path.join(studyRoot, 'STUDY_STATUS.md'), '# Status\n', 'utf8');
    const active = status === 'active';
    const delivered = status === 'delivered_paused';
    const stages = [
      {
        stage_id: '01-study_intake',
        status: active ? 'in_progress' : 'receipt_recorded',
      },
      ...(active
        ? [{ stage_id: '02-protocol_and_analysis_plan', status: 'pending' }]
        : delivered
          ? [
              { stage_id: '08-publication_package_handoff', status: 'typed_blocked' },
              { stage_id: 'manual_foreground_paper_sprint', status: 'missing_manifest' },
              { stage_id: 'milestone_submission_package', status: 'pending' },
            ]
          : []),
    ];
    fs.writeFileSync(path.join(controlRoot, 'stage_index.json'), `${JSON.stringify({
      schema_version: 'mas.study_stage_index.v1',
      study_id: studyId,
      lifecycle_state: status,
      current_stage_id: active ? '01-study_intake' : null,
      current_stage: active ? { stage_id: '01-study_intake' } : null,
      last_recorded_stage_id: delivered ? '08-publication_package_handoff' : '01-study_intake',
      stages,
    }, null, 2)}\n`, 'utf8');
    const nextAction = delivered
      ? {
          action_id: 'complete_submission_metadata_or_wake_for_revision',
          action_type: 'user_action',
          owner: 'user',
          summary: 'Provide missing submission metadata, or explicitly wake the study for revision.',
        }
      : active
        ? {
            action_id: 'continue_current_stage',
            action_type: 'agent_action',
            owner: 'mas',
            summary: 'Continue the current study stage.',
          }
        : {
            action_id: 'wait_for_explicit_user_wakeup',
            action_type: status === 'stopped' ? 'blocked_no_action' : 'user_action',
            owner: 'user',
            summary: 'Wait for an explicit user decision before continuing.',
          };
    return {
      study_id: studyId,
      display_name: displayName,
      canonical_study_root: path.join('studies', studyId),
      status,
      current_stage_id: active ? '01-study_intake' : null,
      current_stage_status: active ? 'in_progress' : null,
      package_status: status === 'delivered_paused' ? 'milestone_delivered' : 'not_ready',
      study_status_ref: 'STUDY_STATUS.md',
      next_action: nextAction,
      stage_index_ref: 'control/stage_index.json',
    };
  });
  fs.writeFileSync(
    path.join(root, 'workspace_index.json'),
    `${JSON.stringify({ workspace_root: root, studies }, null, 2)}\n`,
    'utf8',
  );
}

function binding(input: {
  id: string;
  root: string;
  label: string;
  status: 'active' | 'inactive';
  updatedAt?: string;
  projectScopeId?: string;
}): WorkspaceBinding {
  return {
    binding_id: input.id,
    project_scope_id: input.projectScopeId ?? `project:${input.id}`,
    project_id: 'medautoscience',
    project: 'med-autoscience',
    workspace_path: input.root,
    label: input.label,
    status: input.status,
    direct_entry: {
      command: null,
      manifest_command: null,
      url: null,
      workspace_locator: null,
    },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: input.updatedAt ?? '2026-07-12T00:00:00.000Z',
    archived_at: null,
  };
}

function attempt(input: {
  id: string;
  root: string;
  workItemId: string;
  status: string;
  updatedAt: string;
  tokenUsage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  repairRoute?: Record<string, unknown>;
  stageId?: string;
  qualityCycleId?: string;
  qualityRoundIndex?: number;
  qualityScopeBudget?: Record<string, unknown>;
  createdAt?: string;
  identityField?: 'work_item_id' | 'study_id' | 'quest_id' | 'work_unit_id' | null;
  providerStatus?: string;
  lastHeartbeatAt?: string | null;
  actionRequest?: { ref: string; sha256: string };
  runtimeObservation?: Record<string, unknown>;
  humanGateRefs?: string[];
  blockedReason?: string;
  stageRunId?: string;
  stageRunLaunch?: Record<string, unknown>;
}) {
  const createdAt = input.createdAt ?? '2026-07-10T00:00:00.000Z';
  const identityField = input.identityField === undefined ? 'work_unit_id' : input.identityField;
  const bindingId = path.basename(input.root) === 'DM-CVD-Mortality-Risk'
    ? 'dm-active'
    : path.basename(input.root) === 'NF-PitNET'
      ? 'pitnet-active'
      : 'obesity-inactive';
  const canonicalWorkItemRoot = path.join(input.root, 'studies', input.workItemId);
  fs.mkdirSync(canonicalWorkItemRoot, { recursive: true });
  const executionScope = createWorkItemExecutionScopeSnapshot({
    projectScopeId: `project:${bindingId}`,
    workspaceBindingId: bindingId,
    domainId: 'medautoscience',
    workspaceRoot: input.root,
    payload: { work_item_id: input.workItemId },
    requirement: { kind: 'work_item', alias_fields: ['work_item_id'] },
    canonicalWorkItemRoot,
  });
  const stageRunId = input.stageRunId ?? `sr:${input.id}`;
  return {
    stage_attempt_id: input.id,
    provider_kind: 'temporal',
    workflow_id: `workflow:${input.id}`,
    domain_id: 'medautoscience',
    ...(identityField === null
      ? {
          scope_kind: 'identity_unresolved',
          identity_state: 'identity_unresolved',
          project_scope_id: undefined,
          work_item_scope_id: undefined,
          workspace_binding_id: undefined,
          binding_version_id: undefined,
          scope_digest: undefined,
          execution_scope: undefined,
          stage_run_id: input.stageRunId ?? null,
        }
      : {
          scope_kind: 'work_item',
          identity_state: 'resolved',
          project_scope_id: executionScope.project_scope_id,
          work_item_scope_id: executionScope.work_item_scope_id,
          workspace_binding_id: executionScope.workspace_binding_id,
          binding_version_id: executionScope.binding_version_id,
          scope_digest: executionScope.scope_digest,
          execution_scope: executionScope,
          stage_run_id: stageRunId,
          stage_run_join_state: 'joined',
          stage_run_registered_id: stageRunId,
          stage_run_domain_id: 'medautoscience',
          stage_run_stage_id: input.stageId ?? '01-study_intake',
          stage_run_scope_kind: 'work_item',
          stage_run_project_scope_id: executionScope.project_scope_id,
          stage_run_work_item_scope_id: executionScope.work_item_scope_id,
          stage_run_workspace_binding_id: executionScope.workspace_binding_id,
          stage_run_binding_version_id: executionScope.binding_version_id,
          stage_run_scope_digest: executionScope.scope_digest,
          stage_run_identity_state: 'resolved',
          stage_run_execution_scope_state: 'present',
          stage_run_execution_scope: executionScope,
        }),
    stage_id: input.stageId ?? '01-study_intake',
    workspace_locator: {
      workspace_root: input.root,
      ...(identityField ? { [identityField]: input.workItemId } : {}),
      ...(input.actionRequest ? {
        action_request_ref: input.actionRequest.ref,
        action_request_sha256: input.actionRequest.sha256,
      } : {}),
    },
    executor_kind: 'codex_cli',
    ...(input.stageRunLaunch ? { stage_run_launch: input.stageRunLaunch } : {}),
    status: input.status,
    retry_budget: input.qualityScopeBudget
      ? { quality_scope_budget: input.qualityScopeBudget }
      : {},
    quality_cycle_id: input.qualityCycleId ?? null,
    quality_round_index: input.qualityRoundIndex ?? null,
    attempt_count: 1,
    task_id: `task:${input.workItemId}`,
    blocked_reason: input.blockedReason
      ?? (input.status === 'failed' ? 'historical_provider_failure' : null),
    human_gate_refs: input.humanGateRefs ?? [],
    provider_run: {
      provider_status: input.providerStatus ?? input.status,
      started_at: createdAt,
      completed_at: input.status === 'running' ? null : input.updatedAt,
      last_heartbeat_at: input.lastHeartbeatAt
        ?? (input.status === 'running' ? input.updatedAt : null),
      ...(input.runtimeObservation ? { runtime_observation: input.runtimeObservation } : {}),
    },
    activity_events: input.tokenUsage ? [{ token_usage: input.tokenUsage, usage_status: 'observed' }] : [],
    route_impact: input.repairRoute ? { current_repair_route: input.repairRoute } : {},
    created_at: createdAt,
    updated_at: input.updatedAt,
  };
}

function legacyLocatorAttempt(input: {
  id: string;
  root: string;
  workItemId: string;
  stageId: string;
}) {
  return {
    stage_attempt_id: input.id,
    provider_kind: 'temporal',
    workflow_id: `workflow:${input.id}`,
    domain_id: 'medautoscience',
    scope_kind: 'identity_unresolved',
    identity_state: 'identity_unresolved',
    stage_id: input.stageId,
    workspace_locator: {
      workspace_root: input.root,
      study_id: input.workItemId,
    },
    executor_kind: 'codex_cli',
    status: 'running',
    retry_budget: {},
    attempt_count: 1,
    provider_run: {
      provider_status: 'running',
      started_at: '2026-07-20T00:00:00.000Z',
      completed_at: null,
      last_heartbeat_at: '2026-07-20T00:01:00.000Z',
    },
    activity_events: [{
      token_usage: { input_tokens: 9000, output_tokens: 1000, total_tokens: 10000 },
      usage_status: 'observed',
    }],
    route_impact: {},
    created_at: '2026-07-20T00:00:00.000Z',
    updated_at: '2026-07-20T00:01:00.000Z',
  };
}

type ExecutionScopeFixture = ReturnType<typeof createWorkItemExecutionScopeSnapshot>;

function persistExecutionScopeFixture(db: DatabaseSync, scope: ExecutionScopeFixture) {
  db.prepare(`
    INSERT OR IGNORE INTO execution_scopes(
      scope_digest, scope_kind, project_scope_id, work_item_scope_id, domain_id,
      workspace_binding_id, binding_version_id, execution_scope_json, identity_state, created_at
    ) VALUES (?, 'work_item', ?, ?, ?, ?, ?, ?, 'resolved', ?)
  `).run(
    scope.scope_digest,
    scope.project_scope_id,
    scope.work_item_scope_id,
    scope.domain_id,
    scope.workspace_binding_id,
    scope.binding_version_id,
    JSON.stringify(scope),
    '2026-07-20T00:00:00.000Z',
  );
}

function persistStageRunFixture(db: DatabaseSync, input: {
  id: string;
  stageId: string;
  scope?: ExecutionScopeFixture;
  identityState?: 'resolved' | 'identity_unresolved' | 'quarantined';
}) {
  if (input.scope) persistExecutionScopeFixture(db, input.scope);
  const identityState = input.identityState ?? 'resolved';
  const resolvedScope = input.scope && identityState !== 'identity_unresolved';
  db.prepare(`
    INSERT INTO stage_run_launches(
      stage_run_id, stage_run_invocation_id, stage_run_spec_sha256, domain_id, stage_id,
      workflow_id, scope_kind, project_scope_id, work_item_scope_id, workspace_binding_id,
      binding_version_id, scope_digest, execution_scope_json, identity_state,
      stage_run_input_json, launch_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'started', ?, ?)
  `).run(
    input.id,
    `invocation:${input.id}`,
    `sha256:${createHash('sha256').update(input.id).digest('hex')}`,
    input.scope?.domain_id ?? 'medautoscience',
    input.stageId,
    `workflow:${input.id}`,
    resolvedScope ? 'work_item' : 'identity_unresolved',
    resolvedScope ? input.scope!.project_scope_id : null,
    resolvedScope ? input.scope!.work_item_scope_id : null,
    resolvedScope ? input.scope!.workspace_binding_id : null,
    resolvedScope ? input.scope!.binding_version_id : null,
    resolvedScope ? input.scope!.scope_digest : null,
    resolvedScope ? JSON.stringify(input.scope) : null,
    identityState,
    '2026-07-20T00:00:00.000Z',
    '2026-07-20T00:00:00.000Z',
  );
}

function persistStageAttemptFixture(db: DatabaseSync, input: {
  id: string;
  stageRunId?: string | null;
  stageId: string;
  scope: ExecutionScopeFixture;
  updatedAt: string;
  tokens?: number;
}) {
  persistExecutionScopeFixture(db, input.scope);
  db.prepare(`
    INSERT INTO stage_attempts(
      stage_attempt_id, idempotency_key, provider_kind, workflow_id, domain_id, stage_id,
      workspace_locator_json, executor_kind, stage_run_id, scope_kind, project_scope_id,
      work_item_scope_id, workspace_binding_id, binding_version_id, scope_digest,
      execution_scope_json, identity_state, status, checkpoint_refs_json, closeout_refs_json,
      human_gate_refs_json, retry_budget_json, attempt_count, task_id, provider_receipt_json,
      provider_run_json, activity_events_json, route_impact_json, created_at, updated_at
    ) VALUES (
      ?, ?, 'temporal', ?, ?, ?, '{}', 'codex_cli', ?, 'work_item', ?, ?, ?, ?, ?, ?,
      'resolved', 'running', '[]', '[]', '[]', '{}', 1, ?, '{}', ?, ?, '{}', ?, ?
    )
  `).run(
    input.id,
    `idempotency:${input.id}`,
    `workflow:${input.id}`,
    input.scope.domain_id,
    input.stageId,
    input.stageRunId ?? null,
    input.scope.project_scope_id,
    input.scope.work_item_scope_id,
    input.scope.workspace_binding_id,
    input.scope.binding_version_id,
    input.scope.scope_digest,
    JSON.stringify(input.scope),
    `task:${input.scope.domain_work_item_id}`,
    JSON.stringify({
      provider_status: 'running',
      started_at: '2026-07-20T00:00:00.000Z',
      last_heartbeat_at: input.updatedAt,
    }),
    input.tokens === undefined
      ? '[]'
      : JSON.stringify([{
          token_usage: { input_tokens: input.tokens, output_tokens: 0, total_tokens: input.tokens },
          usage_status: 'observed',
        }]),
    '2026-07-20T00:00:00.000Z',
    input.updatedAt,
  );
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-work-item-v2-'));
  const diabetes = path.join(root, 'DM-CVD-Mortality-Risk');
  const pitnet = path.join(root, 'NF-PitNET');
  const obesity = path.join(root, 'Obesity');
  writeWorkspace(diabetes, 'Diabetes');
  writeWorkspace(pitnet, 'NF-PitNET');
  writeWorkspace(obesity, 'Obesity');
  const bindings = [
    binding({ id: 'dm-active', root: diabetes, label: 'Diabetes', status: 'active' }),
    binding({
      id: 'dm-duplicate-inactive',
      root: diabetes,
      label: 'Diabetes stale duplicate',
      status: 'inactive',
      updatedAt: '2026-07-01T00:00:00.000Z',
      projectScopeId: 'project:dm-active',
    }),
    binding({ id: 'pitnet-active', root: pitnet, label: 'NF-PitNET', status: 'active' }),
    binding({ id: 'obesity-inactive', root: obesity, label: 'Obesity', status: 'inactive' }),
  ];
  const packageIds = ['mas', 'mag', 'rca', 'oma', 'obf', 'synthetic-agent'];
  const packageProjectionItems = packageIds.map((packageId) => ({
    package_id: packageId,
    source_present: true,
    source_health_status: 'current',
    source_path: `/packages/${packageId}`,
  }));
  const packageStatusById = Object.fromEntries(packageProjectionItems.map((item) => [
    item.package_id,
    {
      status: 'installed',
      codex_visible: true,
      package_version: '1.0.0',
      package_lock_ref: `/locks/${item.package_id}.json`,
      launch_allowed: true,
      launch_blocked_reason: null,
    },
  ]));
  return {
    root,
    diabetes,
    pitnet,
    obesity,
    bindings,
    packageProjectionItems,
    packageStatusById,
    resolveDescriptor: (agentId: string) => ['mas', 'medautoscience', 'med-autoscience'].includes(agentId)
      ? masDescriptor()
      : packageIds.includes(agentId)
        ? identityDescriptor(agentId)
        : null,
  };
}

function writeActionRequest(root: string, runId: string, payload: Record<string, unknown>) {
  const requestPath = path.join(root, 'control', 'opl', 'action_runs', runId, 'request.json');
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  fs.writeFileSync(requestPath, bytes);
  return {
    ref: pathToFileURL(requestPath).href,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function casReadGuardPaths(stateRoot: string, workspaceRoot: string, requestSha256 = 'a'.repeat(64)) {
  const workspaceKey = crypto.createHash('sha256')
    .update(fs.realpathSync.native(workspaceRoot))
    .digest('hex');
  const root = path.join(stateRoot, 'runway', 'domain-artifact-cas');
  return {
    epoch: path.join(root, 'read-epochs', `${workspaceKey}.json`),
    journal: path.join(root, 'transactions', `${workspaceKey}-${requestSha256}.json`),
    workspaceKey,
    requestSha256,
  };
}

function writeCasReadEpoch(input: {
  stateRoot: string;
  workspaceRoot: string;
  transitionId: string;
  phase: 'in_progress' | 'settled';
}) {
  const paths = casReadGuardPaths(input.stateRoot, input.workspaceRoot);
  fs.mkdirSync(path.dirname(paths.epoch), { recursive: true });
  fs.writeFileSync(paths.epoch, `${JSON.stringify({
    surface_kind: 'opl_domain_artifact_cas_read_epoch',
    version: 'opl-domain-artifact-cas-read-epoch.v1',
    workspace_sha256: paths.workspaceKey,
    request_sha256: paths.requestSha256,
    transition_id: input.transitionId,
    phase: input.phase,
    outcome: input.phase === 'settled' ? 'materialized' : null,
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  return paths;
}

function writeCasJournal(stateRoot: string, workspaceRoot: string) {
  const paths = casReadGuardPaths(stateRoot, workspaceRoot);
  fs.mkdirSync(path.dirname(paths.journal), { recursive: true });
  fs.writeFileSync(paths.journal, `${JSON.stringify({
    surface_kind: 'opl_domain_artifact_cas_transaction_journal',
    version: 'opl-domain-artifact-cas-transaction-journal.v1',
    request_sha256: paths.requestSha256,
    phase: 'switching',
    visibility_model: 'cooperating_opl_readers_must_treat_journal_as_sync_pending',
    operations: [],
  }, null, 2)}\n`, 'utf8');
  return paths;
}

function persistStageAttempt(db: DatabaseSync, value: ReturnType<typeof attempt>) {
  const scopeWrite = normalizeRuntimeExecutionScopeWrite({
    domainId: value.domain_id,
    scopeKind: value.scope_kind === 'work_item' ? 'work_item' : undefined,
    executionScope: value.execution_scope ?? null,
  });
  persistRuntimeExecutionScope(db, scopeWrite, value.domain_id);
  db.prepare(`
    INSERT INTO stage_attempts (
      stage_attempt_id, idempotency_key, provider_kind, workflow_id,
      domain_id, scope_kind, project_scope_id, work_item_scope_id,
      workspace_binding_id, binding_version_id, scope_digest,
      execution_scope_json, identity_state,
      stage_id, workspace_locator_json, source_fingerprint,
      executor_kind, stage_run_id, status, checkpoint_refs_json,
      closeout_refs_json, human_gate_refs_json, retry_budget_json,
      attempt_count, task_id, blocked_reason, provider_receipt_json,
      provider_run_json, activity_events_json, route_impact_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)
  `).run(
    value.stage_attempt_id,
    `idempotency:${value.stage_attempt_id}`,
    value.provider_kind,
    value.workflow_id,
    value.domain_id,
    value.scope_kind,
    value.project_scope_id ?? null,
    value.work_item_scope_id ?? null,
    value.workspace_binding_id ?? null,
    value.binding_version_id ?? null,
    value.scope_digest ?? null,
    value.execution_scope ? JSON.stringify(value.execution_scope) : null,
    value.identity_state,
    value.stage_id,
    JSON.stringify(value.workspace_locator),
    value.executor_kind,
    value.stage_run_id,
    value.status,
    JSON.stringify(value.human_gate_refs),
    JSON.stringify(value.retry_budget),
    value.attempt_count,
    value.task_id,
    value.blocked_reason,
    JSON.stringify(value.provider_run),
    JSON.stringify(value.activity_events),
    JSON.stringify(value.route_impact),
    value.created_at,
    value.updated_at,
  );
}

export {
  assert,
  crypto,
  createHash,
  fs,
  os,
  path,
  DatabaseSync,
  pathToFileURL,
  test,
  parseJsonText,
  record,
  parseStandardAgentInterface,
  STANDARD_AGENT_INTERFACE_VERSION,
  validateJsonSchemaPayload,
  buildAgentCatalog,
  joinAttemptsToWorkItems,
  readWorkItemStageAttemptsFromDb,
  buildAppRuntimeWorkItemProjection,
  readStageIndexPresentation,
  readWorkItemStageAttempts,
  projectRuntimeActivityItems,
  buildWorkItemProjectionV2,
  projectWorkItemPrimaryState,
  buildStageAttemptRuntimeCurrentness,
  createStageAttemptTable,
  normalizeRuntimeExecutionScopeWrite,
  persistRuntimeExecutionScope,
  createStageRunLaunchTable,
  setWorkItemControlState,
  setWorkItemVisibilityState,
  createWorkItemExecutionScopeSnapshot,
  MAS_STUDIES,
  masDescriptor,
  identityDescriptor,
  writeWorkspace,
  binding,
  attempt,
  legacyLocatorAttempt,
  persistExecutionScopeFixture,
  persistStageRunFixture,
  persistStageAttemptFixture,
  fixture,
  writeActionRequest,
  casReadGuardPaths,
  writeCasReadEpoch,
  writeCasJournal,
  persistStageAttempt,
};

export type {
  StandardAgentDescriptorInterface,
  WorkspaceBinding,
  ExecutionScopeFixture,
};
