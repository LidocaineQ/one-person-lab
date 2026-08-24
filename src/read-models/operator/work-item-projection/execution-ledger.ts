import fs from 'node:fs';
import path from 'node:path';

import { isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import { record, stringValue, type JsonRecord } from '../../../kernel/json-record.ts';
import { resolveOplStatePaths } from '../../../kernel/runtime-state-paths.ts';
import {
  listStageAttempts,
  openFamilyRuntimeSqlite,
} from '../../../adapters/execution/public/app-state.ts';
import type {
  WorkItemProjectionDiagnostic,
  WorkItemProjectionItem,
} from './types.ts';

export const MAX_DIAGNOSTIC_ATTEMPTS = 100;
export const ATTEMPT_DETAIL_BATCH_SIZE = 200;
export const STAGE_RUN_DIAGNOSTIC_ONLY_RECORD_KIND = 'stage_run_without_stage_attempt';
export const STAGE_RUN_WITHOUT_ATTEMPT_REASON = 'stage_run_without_stage_attempt';
const STAGE_RUN_EXECUTION_IDENTITY_COLUMNS = [
  'stage_run_id',
  'domain_id',
  'stage_id',
  'scope_kind',
  'project_scope_id',
  'work_item_scope_id',
  'workspace_binding_id',
  'binding_version_id',
  'scope_digest',
  'execution_scope_json',
  'identity_state',
] as const;

export function normalizedStatus(value: unknown) {
  return stringValue(value)?.toLowerCase().replace(/[\s-]+/g, '_') ?? 'unknown';
}

export function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function attemptStageRunLaunch(attempt: JsonRecord) {
  const launch = record(attempt.stage_run_launch);
  return launch.surface_kind === 'opl_stage_run_launch_registry_entry'
    && launch.version === 'opl-stage-run-launch-registry-entry.v2'
    && stringValue(launch.stage_run_id) === stringValue(attempt.stage_run_id)
    && stringValue(launch.domain_id) === stringValue(attempt.domain_id)
    && stringValue(launch.stage_id) === stringValue(attempt.stage_id)
    ? launch
    : {};
}

export function effectiveAttemptStatus(attempt: JsonRecord) {
  const launch = attemptStageRunLaunch(attempt);
  const terminalStatus = normalizedStatus(launch.terminal_status);
  return launch.launch_status === 'closed' && terminalStatus === 'human_gate'
    ? terminalStatus
    : normalizedStatus(attempt.status);
}

export function attemptWorkflowId(attempt: JsonRecord) {
  return stringValue(attemptStageRunLaunch(attempt).workflow_id)
    ?? stringValue(attempt.workflow_id);
}

export function attemptObservedAt(attempt: JsonRecord) {
  return stringValue(attemptStageRunLaunch(attempt).updated_at)
    ?? stringValue(attempt.updated_at)
    ?? stringValue(attempt.created_at);
}

export function newestFirst(left: JsonRecord, right: JsonRecord) {
  const updated = Date.parse(attemptObservedAt(right) ?? '') - Date.parse(attemptObservedAt(left) ?? '');
  if (Number.isFinite(updated) && updated !== 0) return updated;
  return (stringValue(right.stage_attempt_id) ?? '').localeCompare(stringValue(left.stage_attempt_id) ?? '');
}

export function newestStageRunDiagnosticFirst(left: JsonRecord, right: JsonRecord) {
  const leftObservedAt = stringValue(left.updated_at) ?? stringValue(left.created_at);
  const rightObservedAt = stringValue(right.updated_at) ?? stringValue(right.created_at);
  const updated = Date.parse(rightObservedAt ?? '') - Date.parse(leftObservedAt ?? '');
  if (Number.isFinite(updated) && updated !== 0) return updated;
  return (stringValue(right.stage_run_id) ?? '').localeCompare(stringValue(left.stage_run_id) ?? '');
}

type StageRunExecutionIdentityJoinRow = {
  projection_stage_attempt_id: unknown;
  attempt_stage_run_id: unknown;
  registered_stage_run_id: unknown;
  stage_run_domain_id: unknown;
  stage_run_stage_id: unknown;
  stage_run_scope_kind: unknown;
  stage_run_project_scope_id: unknown;
  stage_run_work_item_scope_id: unknown;
  stage_run_workspace_binding_id: unknown;
  stage_run_binding_version_id: unknown;
  stage_run_scope_digest: unknown;
  stage_run_execution_scope_json: unknown;
  stage_run_identity_state: unknown;
};

type StageRunWithoutAttemptRow = Omit<
  StageRunExecutionIdentityJoinRow,
  'projection_stage_attempt_id' | 'attempt_stage_run_id'
> & {
  stage_run_launch_status: unknown;
  stage_run_terminal_status: unknown;
  stage_run_last_start_error: unknown;
  stage_run_created_at: unknown;
  stage_run_updated_at: unknown;
};

function sqliteTableColumns(
  db: Parameters<typeof listStageAttempts>[0],
  tableName: 'stage_attempts' | 'stage_run_launches',
) {
  return new Set((db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
    .map((column) => column.name));
}

function stageRunIdentityUnavailable(attempt: JsonRecord) {
  return {
    ...attempt,
    stage_run_join_state: 'identity_schema_unavailable',
    stage_run_registered_id: null,
    stage_run_execution_scope_state: 'unavailable',
    stage_run_execution_scope: null,
  } as JsonRecord;
}

function parseStageRunExecutionScope(value: unknown) {
  const json = stringValue(value);
  if (!json) {
    return { state: 'missing', snapshot: null } as const;
  }
  try {
    return { state: 'present', snapshot: JSON.parse(json) as unknown } as const;
  } catch {
    return { state: 'invalid_json', snapshot: null } as const;
  }
}

function stageRunExecutionIdentityProjection(row: StageRunExecutionIdentityJoinRow) {
  const attemptStageRunId = stringValue(row.attempt_stage_run_id);
  const registeredStageRunId = stringValue(row.registered_stage_run_id);
  if (!attemptStageRunId) {
    return {
      stage_run_join_state: 'attempt_unbound',
      stage_run_registered_id: null,
      stage_run_execution_scope_state: 'missing',
      stage_run_execution_scope: null,
    } as const;
  }
  if (!registeredStageRunId) {
    return {
      stage_run_join_state: 'stage_run_not_found',
      stage_run_registered_id: null,
      stage_run_execution_scope_state: 'missing',
      stage_run_execution_scope: null,
    } as const;
  }
  const snapshot = parseStageRunExecutionScope(row.stage_run_execution_scope_json);
  return {
    stage_run_join_state: 'joined',
    stage_run_registered_id: registeredStageRunId,
    stage_run_domain_id: stringValue(row.stage_run_domain_id),
    stage_run_stage_id: stringValue(row.stage_run_stage_id),
    stage_run_scope_kind: stringValue(row.stage_run_scope_kind),
    stage_run_project_scope_id: stringValue(row.stage_run_project_scope_id),
    stage_run_work_item_scope_id: stringValue(row.stage_run_work_item_scope_id),
    stage_run_workspace_binding_id: stringValue(row.stage_run_workspace_binding_id),
    stage_run_binding_version_id: stringValue(row.stage_run_binding_version_id),
    stage_run_scope_digest: stringValue(row.stage_run_scope_digest),
    stage_run_identity_state: stringValue(row.stage_run_identity_state),
    stage_run_execution_scope_state: snapshot.state,
    stage_run_execution_scope: snapshot.snapshot,
  } as const;
}

function stageRunWithoutAttemptProjection(row: StageRunWithoutAttemptRow): JsonRecord {
  const stageRunId = stringValue(row.registered_stage_run_id);
  const snapshot = parseStageRunExecutionScope(row.stage_run_execution_scope_json);
  return {
    projection_record_kind: STAGE_RUN_DIAGNOSTIC_ONLY_RECORD_KIND,
    stage_run_id: stageRunId,
    domain_id: stringValue(row.stage_run_domain_id),
    stage_id: stringValue(row.stage_run_stage_id),
    scope_kind: stringValue(row.stage_run_scope_kind),
    project_scope_id: stringValue(row.stage_run_project_scope_id),
    work_item_scope_id: stringValue(row.stage_run_work_item_scope_id),
    workspace_binding_id: stringValue(row.stage_run_workspace_binding_id),
    binding_version_id: stringValue(row.stage_run_binding_version_id),
    scope_digest: stringValue(row.stage_run_scope_digest),
    execution_scope: snapshot.snapshot,
    identity_state: stringValue(row.stage_run_identity_state),
    stage_run_join_state: STAGE_RUN_DIAGNOSTIC_ONLY_RECORD_KIND,
    stage_run_registered_id: stageRunId,
    stage_run_domain_id: stringValue(row.stage_run_domain_id),
    stage_run_stage_id: stringValue(row.stage_run_stage_id),
    stage_run_scope_kind: stringValue(row.stage_run_scope_kind),
    stage_run_project_scope_id: stringValue(row.stage_run_project_scope_id),
    stage_run_work_item_scope_id: stringValue(row.stage_run_work_item_scope_id),
    stage_run_workspace_binding_id: stringValue(row.stage_run_workspace_binding_id),
    stage_run_binding_version_id: stringValue(row.stage_run_binding_version_id),
    stage_run_scope_digest: stringValue(row.stage_run_scope_digest),
    stage_run_identity_state: stringValue(row.stage_run_identity_state),
    stage_run_execution_scope_state: snapshot.state,
    stage_run_execution_scope: snapshot.snapshot,
    stage_run_launch_status: stringValue(row.stage_run_launch_status),
    stage_run_terminal_status: stringValue(row.stage_run_terminal_status),
    stage_run_last_start_error: stringValue(row.stage_run_last_start_error),
    created_at: stringValue(row.stage_run_created_at),
    updated_at: stringValue(row.stage_run_updated_at),
  };
}

export function isStageRunWithoutAttemptProjection(value: JsonRecord) {
  return value.projection_record_kind === STAGE_RUN_DIAGNOSTIC_ONLY_RECORD_KIND;
}

export function readWorkItemStageAttemptsFromDb(
  db: Parameters<typeof listStageAttempts>[0],
): JsonRecord[] {
  const attempts = listStageAttempts(db, { archived: 'exclude' }).filter(isRecord);
  const attemptColumns = sqliteTableColumns(db, 'stage_attempts');
  const stageRunTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage_run_launches'",
  ).get();
  if (!attemptColumns.has('stage_run_id') || !stageRunTable) {
    return attempts.map(stageRunIdentityUnavailable);
  }
  const stageRunColumns = sqliteTableColumns(db, 'stage_run_launches');
  if (STAGE_RUN_EXECUTION_IDENTITY_COLUMNS.some((column) => !stageRunColumns.has(column))) {
    return attempts.map(stageRunIdentityUnavailable);
  }
  const joinedRows = db.prepare(`
    SELECT
      attempts.stage_attempt_id AS projection_stage_attempt_id,
      attempts.stage_run_id AS attempt_stage_run_id,
      stage_runs.stage_run_id AS registered_stage_run_id,
      stage_runs.domain_id AS stage_run_domain_id,
      stage_runs.stage_id AS stage_run_stage_id,
      stage_runs.scope_kind AS stage_run_scope_kind,
      stage_runs.project_scope_id AS stage_run_project_scope_id,
      stage_runs.work_item_scope_id AS stage_run_work_item_scope_id,
      stage_runs.workspace_binding_id AS stage_run_workspace_binding_id,
      stage_runs.binding_version_id AS stage_run_binding_version_id,
      stage_runs.scope_digest AS stage_run_scope_digest,
      stage_runs.execution_scope_json AS stage_run_execution_scope_json,
      stage_runs.identity_state AS stage_run_identity_state
    FROM stage_attempts AS attempts
    LEFT JOIN stage_run_launches AS stage_runs
      ON stage_runs.stage_run_id = attempts.stage_run_id
    WHERE attempts.archived_at IS NULL
  `).all() as StageRunExecutionIdentityJoinRow[];
  const stageRunIdentityByAttempt = new Map(joinedRows.map((row) => [
    stringValue(row.projection_stage_attempt_id) ?? '',
    stageRunExecutionIdentityProjection(row),
  ]));
  const projectedAttempts = attempts.map((attempt) => ({
    ...attempt,
    ...(stageRunIdentityByAttempt.get(stringValue(attempt.stage_attempt_id) ?? '')
      ?? {
        stage_run_join_state: 'projection_join_missing',
        stage_run_registered_id: null,
        stage_run_execution_scope_state: 'unavailable',
        stage_run_execution_scope: null,
      }),
  }));
  const stageRunsWithoutAttempts = db.prepare(`
    SELECT
      stage_runs.stage_run_id AS registered_stage_run_id,
      stage_runs.domain_id AS stage_run_domain_id,
      stage_runs.stage_id AS stage_run_stage_id,
      stage_runs.scope_kind AS stage_run_scope_kind,
      stage_runs.project_scope_id AS stage_run_project_scope_id,
      stage_runs.work_item_scope_id AS stage_run_work_item_scope_id,
      stage_runs.workspace_binding_id AS stage_run_workspace_binding_id,
      stage_runs.binding_version_id AS stage_run_binding_version_id,
      stage_runs.scope_digest AS stage_run_scope_digest,
      stage_runs.execution_scope_json AS stage_run_execution_scope_json,
      stage_runs.identity_state AS stage_run_identity_state,
      stage_runs.launch_status AS stage_run_launch_status,
      stage_runs.terminal_status AS stage_run_terminal_status,
      stage_runs.last_start_error AS stage_run_last_start_error,
      stage_runs.created_at AS stage_run_created_at,
      stage_runs.updated_at AS stage_run_updated_at
    FROM stage_run_launches AS stage_runs
    WHERE NOT EXISTS (
      SELECT 1
      FROM stage_attempts AS attempts
      WHERE attempts.stage_run_id = stage_runs.stage_run_id
    )
    ORDER BY stage_runs.updated_at DESC, stage_runs.stage_run_id DESC
  `).all() as StageRunWithoutAttemptRow[];
  return [
    ...projectedAttempts,
    ...stageRunsWithoutAttempts.map(stageRunWithoutAttemptProjection),
  ];
}

type WorkItemAttemptReadScope = {
  items: WorkItemProjectionItem[];
};

const COMPACT_USAGE_FIELDS = [
  ['source_ref', '$.source_ref'],
  ['usage_ref', '$.usage_ref'],
  ['usage_refs', '$.usage_refs'],
  ['session_usage_refs', '$.session_usage_refs'],
  ['token_usage', '$.token_usage'],
  ['cost_summary', '$.cost_summary'],
  ['estimated_cost_usd', '$.estimated_cost_usd'],
  ['api_call_count', '$.api_call_count'],
  ['duration_ms', '$.duration_ms'],
  ['cadence_ref', '$.cadence_ref'],
  ['cost_status', '$.cost_status'],
  ['usage_status', '$.usage_status'],
  ['telemetry_status', '$.telemetry_status'],
  ['missing_reason', '$.missing_reason'],
  ['missing_usage_telemetry_reason', '$.missing_usage_telemetry_reason'],
] as const;

const REQUIRED_SCOPED_ATTEMPT_COLUMNS = [
  'stage_run_id',
  'scope_kind',
  'project_scope_id',
  'work_item_scope_id',
  'workspace_binding_id',
  'binding_version_id',
  'scope_digest',
  'execution_scope_json',
  'identity_state',
] as const;

function sqliteTableExists(
  db: Parameters<typeof listStageAttempts>[0],
  tableName: string,
) {
  return Boolean(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName));
}

function compactJsonObjectExpression(
  column: string,
  fields: ReadonlyArray<readonly [string, string]>,
) {
  const entries = fields.flatMap(([key, jsonPath]) => [
    `'${key}'`,
    `json_extract(${column}, '${jsonPath}')`,
  ]);
  return `CASE WHEN json_valid(${column}) THEN json_object(${entries.join(', ')}) ELSE '{}' END`;
}

function compactActivityUsageExpression(column: string) {
  const activityFields = COMPACT_USAGE_FIELDS.filter(([key]) => [
    'source_ref',
    'usage_ref',
    'usage_refs',
    'session_usage_refs',
    'token_usage',
    'cost_summary',
    'usage_status',
    'telemetry_status',
    'missing_reason',
    'missing_usage_telemetry_reason',
  ].includes(key));
  const entries = [
    "'__opl_compact_source_index'",
    'event.key',
    ...activityFields.flatMap(([key, jsonPath]) => [
      `'${key}'`,
      `CASE WHEN event.type = 'object' THEN json_extract(event.value, '${jsonPath}') ELSE NULL END`,
    ]),
  ];
  const relevant = [
    "json_type(event.value, '$.token_usage') IS NOT NULL",
    "json_type(event.value, '$.cost_summary.token_usage') IS NOT NULL",
  ].join(' OR ');
  return `
    CASE WHEN instr(${column}, '"token_usage"') = 0
      AND instr(${column}, '"cost_summary"') = 0 THEN '[]'
    WHEN json_valid(${column}) THEN COALESCE((
      SELECT json_group_array(json_object(${entries.join(', ')}))
      FROM json_each(${column}) AS event
      WHERE event.type = 'object'
        AND (${relevant})
    ), '[]') ELSE '[]' END
  `;
}

function parseCompactRecord(value: unknown): JsonRecord {
  if (typeof value !== 'string') return {};
  try {
    const parsed = parseJsonText(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseCompactList(value: unknown): unknown[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = parseJsonText(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function batches<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function scopePredicate(
  tableAlias: string,
  items: WorkItemProjectionItem[],
  parameters: string[],
) {
  return items.map((item) => {
    parameters.push(
      item.identity.domain_id,
      item.identity.project_scope_id,
      item.identity.work_item_scope_id,
      item.identity.workspace_binding_id,
    );
    return `(
      ${tableAlias}.domain_id = ?
      AND ${tableAlias}.project_scope_id = ?
      AND ${tableAlias}.work_item_scope_id = ?
      AND ${tableAlias}.workspace_binding_id = ?
    )`;
  }).join(' OR ');
}

function readScopedWorkItemStageAttemptsFromDb(input: {
  db: Parameters<typeof listStageAttempts>[0];
  scope: WorkItemAttemptReadScope;
  validateIrrelevantActivityJson: boolean;
}) {
  const diagnostics: WorkItemProjectionDiagnostic[] = [];
  if (input.scope.items.length === 0) {
    return { attempts: [] as JsonRecord[], qualityCycles: [] as JsonRecord[], diagnostics };
  }
  if (!sqliteTableExists(input.db, 'stage_attempts')) {
    diagnostics.push({ reason: 'stage_attempt_compact_identity_schema_unavailable' });
    return { attempts: [] as JsonRecord[], qualityCycles: [] as JsonRecord[], diagnostics };
  }
  const attemptColumns = sqliteTableColumns(input.db, 'stage_attempts');
  const missingAttemptColumns = REQUIRED_SCOPED_ATTEMPT_COLUMNS.filter(
    (column) => !attemptColumns.has(column),
  );
  if (missingAttemptColumns.length > 0) {
    diagnostics.push({
      reason: 'stage_attempt_compact_identity_schema_unavailable',
      details: { missing_fields: [...missingAttemptColumns] },
    });
    return { attempts: [] as JsonRecord[], qualityCycles: [] as JsonRecord[], diagnostics };
  }

  const launchTableExists = sqliteTableExists(input.db, 'stage_run_launches');
  const launchColumns = launchTableExists
    ? sqliteTableColumns(input.db, 'stage_run_launches')
    : new Set<string>();
  const launchIdentityAvailable = launchTableExists
    && STAGE_RUN_EXECUTION_IDENTITY_COLUMNS.every((column) => launchColumns.has(column));
  const attemptColumn = (column: string, fallback = 'NULL') => (
    attemptColumns.has(column) ? `attempts.${column}` : fallback
  );
  const launchColumn = (column: string, fallback = 'NULL') => (
    launchColumns.has(column) ? `stage_runs.${column}` : fallback
  );
  const providerFields = [
    ['provider_status', '$.provider_status'],
    ['started_at', '$.started_at'],
    ['completed_at', '$.completed_at'],
    ['last_heartbeat_at', '$.last_heartbeat_at'],
    ['runtime_observation', '$.runtime_observation'],
    ['usage_projection', '$.usage_projection'],
    ...COMPACT_USAGE_FIELDS,
  ] as const;
  const routeFields = [
    ['current_repair_route', '$.current_repair_route'],
    ['repair_route', '$.repair_route'],
    ['selected_repair_route', '$.selected_repair_route'],
    ['usage_projection', '$.usage_projection'],
  ] as const;
  const activityJsonValidity = input.validateIrrelevantActivityJson
    ? 'json_valid(attempts.activity_events_json)'
    : `CASE WHEN instr(attempts.activity_events_json, '"token_usage"') = 0
        AND instr(attempts.activity_events_json, '"cost_summary"') = 0
      THEN 1 ELSE json_valid(attempts.activity_events_json) END`;
  const launchSelect = launchTableExists
    ? `
      ${launchColumn('stage_run_id')} AS registered_stage_run_id,
      ${launchColumn('domain_id')} AS stage_run_domain_id,
      ${launchColumn('stage_id')} AS stage_run_stage_id,
      ${launchColumn('scope_kind')} AS stage_run_scope_kind,
      ${launchColumn('project_scope_id')} AS stage_run_project_scope_id,
      ${launchColumn('work_item_scope_id')} AS stage_run_work_item_scope_id,
      ${launchColumn('workspace_binding_id')} AS stage_run_workspace_binding_id,
      ${launchColumn('binding_version_id')} AS stage_run_binding_version_id,
      ${launchColumn('scope_digest')} AS stage_run_scope_digest,
      ${launchColumn('execution_scope_json')} AS stage_run_execution_scope_json,
      ${launchColumn('identity_state')} AS stage_run_identity_state,
      ${launchColumn('stage_run_invocation_id')} AS launch_stage_run_invocation_id,
      ${launchColumn('stage_run_spec_sha256')} AS launch_stage_run_spec_sha256,
      ${launchColumn('stage_run_input_json')} AS launch_stage_run_input_json,
      ${launchColumn('workflow_id')} AS launch_workflow_id,
      ${launchColumn('parent_route_decision_ref')} AS launch_parent_route_decision_ref,
      ${launchColumn('launch_status')} AS launch_status,
      ${launchColumn('terminal_status')} AS launch_terminal_status,
      ${launchColumn('last_start_error')} AS launch_last_start_error,
      ${launchColumn('created_at')} AS launch_created_at,
      ${launchColumn('updated_at')} AS launch_updated_at
    `
    : `
      NULL AS registered_stage_run_id,
      NULL AS stage_run_domain_id,
      NULL AS stage_run_stage_id,
      NULL AS stage_run_scope_kind,
      NULL AS stage_run_project_scope_id,
      NULL AS stage_run_work_item_scope_id,
      NULL AS stage_run_workspace_binding_id,
      NULL AS stage_run_binding_version_id,
      NULL AS stage_run_scope_digest,
      NULL AS stage_run_execution_scope_json,
      NULL AS stage_run_identity_state,
      NULL AS launch_stage_run_invocation_id,
      NULL AS launch_stage_run_spec_sha256,
      NULL AS launch_stage_run_input_json,
      NULL AS launch_workflow_id,
      NULL AS launch_parent_route_decision_ref,
      NULL AS launch_status,
      NULL AS launch_terminal_status,
      NULL AS launch_last_start_error,
      NULL AS launch_created_at,
      NULL AS launch_updated_at
    `;
  const rows = batches(input.scope.items, ATTEMPT_DETAIL_BATCH_SIZE).flatMap((items) => {
    const parameters: string[] = [];
    const predicate = scopePredicate('attempts', items, parameters);
    return input.db.prepare(`
      SELECT
        attempts.stage_attempt_id AS projection_stage_attempt_id,
        attempts.stage_attempt_id,
        attempts.stage_run_id AS attempt_stage_run_id,
        attempts.stage_run_id,
        attempts.provider_kind,
        attempts.workflow_id,
        attempts.domain_id,
        attempts.stage_id,
        attempts.executor_kind,
        ${attemptColumn('execution_session_ref')} AS execution_session_ref,
        attempts.scope_kind,
        attempts.project_scope_id,
        attempts.work_item_scope_id,
        attempts.workspace_binding_id,
        attempts.binding_version_id,
        attempts.scope_digest,
        attempts.identity_state,
        ${attemptColumn('quality_cycle_id')} AS quality_cycle_id,
        ${attemptColumn('attempt_role')} AS attempt_role,
        ${attemptColumn('quality_round_index')} AS quality_round_index,
        attempts.status,
        attempts.attempt_count,
        attempts.task_id,
        attempts.blocked_reason,
        attempts.created_at,
        attempts.updated_at,
        json_valid(attempts.execution_scope_json) AS execution_scope_json_valid,
        json_valid(attempts.provider_run_json) AS provider_run_json_valid,
        ${activityJsonValidity} AS activity_events_json_valid,
        json_valid(attempts.route_impact_json) AS route_impact_json_valid,
        CASE WHEN json_valid(attempts.execution_scope_json)
          THEN attempts.execution_scope_json ELSE '{}' END AS execution_scope_compact_json,
        ${compactJsonObjectExpression('attempts.provider_run_json', providerFields)} AS provider_run_compact_json,
        ${compactActivityUsageExpression('attempts.activity_events_json')} AS activity_usage_events_json,
        ${compactJsonObjectExpression('attempts.route_impact_json', routeFields)} AS route_impact_compact_json,
        CASE WHEN json_valid(attempts.retry_budget_json)
          THEN attempts.retry_budget_json ELSE '{}' END AS retry_budget_compact_json,
        CASE WHEN json_valid(attempts.human_gate_refs_json)
          THEN attempts.human_gate_refs_json ELSE '[]' END AS human_gate_refs_compact_json,
        CASE WHEN ${attemptColumn('usage_observation_json')} IS NOT NULL
          AND json_valid(${attemptColumn('usage_observation_json')})
          THEN ${attemptColumn('usage_observation_json')} ELSE NULL END AS usage_observation_compact_json,
        ${launchSelect}
      FROM stage_attempts AS attempts
      ${launchTableExists
        ? 'LEFT JOIN stage_run_launches AS stage_runs ON stage_runs.stage_run_id = attempts.stage_run_id'
        : ''}
      WHERE ${attemptColumns.has('archived_at') ? 'attempts.archived_at IS NULL' : '1 = 1'}
        AND attempts.scope_kind = 'work_item'
        AND attempts.identity_state = 'resolved'
        AND (${predicate})
      ORDER BY attempts.updated_at DESC, attempts.created_at DESC, attempts.stage_attempt_id DESC
    `).all(...parameters) as Array<Record<string, unknown>>;
  });

  const attempts = rows.map((row): JsonRecord => {
    const attemptId = stringValue(row.stage_attempt_id) ?? 'unknown-stage-attempt';
    for (const [field, valid] of [
      ['execution_scope_json', row.execution_scope_json_valid],
      ['provider_run_json', row.provider_run_json_valid],
      ['activity_events_json', row.activity_events_json_valid],
      ['route_impact_json', row.route_impact_json_valid],
    ] as const) {
      if (valid === 0 && diagnostics.length < MAX_DIAGNOSTIC_ATTEMPTS) {
        diagnostics.push({
          reason: 'stage_attempt_compact_json_invalid',
          ref: attemptId,
          details: { field },
        });
      }
    }
    const registeredStageRunId = stringValue(row.registered_stage_run_id);
    const stageRunLaunch = registeredStageRunId ? {
      surface_kind: 'opl_stage_run_launch_registry_entry',
      version: 'opl-stage-run-launch-registry-entry.v2',
      stage_run_id: registeredStageRunId,
      stage_run_invocation_id: row.launch_stage_run_invocation_id,
      stage_run_spec_sha256: row.launch_stage_run_spec_sha256,
      stage_run_input: parseCompactRecord(row.launch_stage_run_input_json),
      domain_id: row.stage_run_domain_id,
      stage_id: row.stage_run_stage_id,
      workflow_id: row.launch_workflow_id,
      parent_route_decision_ref: row.launch_parent_route_decision_ref,
      launch_status: row.launch_status,
      terminal_status: row.launch_terminal_status,
      last_start_error: row.launch_last_start_error,
      created_at: row.launch_created_at,
      updated_at: row.launch_updated_at,
    } : null;
    const attempt: JsonRecord = {
      stage_attempt_id: attemptId,
      provider_kind: row.provider_kind,
      workflow_id: row.workflow_id,
      domain_id: row.domain_id,
      stage_id: row.stage_id,
      workspace_locator: {},
      executor_kind: row.executor_kind,
      execution_session_ref: row.execution_session_ref,
      stage_run_id: row.stage_run_id,
      scope_kind: row.scope_kind,
      project_scope_id: row.project_scope_id,
      work_item_scope_id: row.work_item_scope_id,
      workspace_binding_id: row.workspace_binding_id,
      binding_version_id: row.binding_version_id,
      scope_digest: row.scope_digest,
      execution_scope: parseCompactRecord(row.execution_scope_compact_json),
      identity_state: row.identity_state,
      quality_cycle_id: row.quality_cycle_id,
      attempt_role: row.attempt_role,
      quality_round_index: row.quality_round_index,
      status: row.status,
      retry_budget: parseCompactRecord(row.retry_budget_compact_json),
      attempt_count: row.attempt_count,
      task_id: row.task_id,
      blocked_reason: row.blocked_reason,
      human_gate_refs: parseCompactList(row.human_gate_refs_compact_json),
      provider_run: parseCompactRecord(row.provider_run_compact_json),
      activity_events: parseCompactList(row.activity_usage_events_json),
      route_impact: parseCompactRecord(row.route_impact_compact_json),
      usage_observation: row.usage_observation_compact_json === null
        ? null
        : parseCompactRecord(row.usage_observation_compact_json),
      ...(stageRunLaunch ? { stage_run_launch: stageRunLaunch } : {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return launchIdentityAvailable
      ? {
          ...attempt,
          ...stageRunExecutionIdentityProjection(row as unknown as StageRunExecutionIdentityJoinRow),
        }
      : stageRunIdentityUnavailable(attempt);
  }).sort(newestFirst);

  const stageRunsWithoutAttempts = launchIdentityAvailable
    ? batches(input.scope.items, ATTEMPT_DETAIL_BATCH_SIZE).flatMap((items) => {
        const parameters: string[] = [];
        const predicate = scopePredicate('stage_runs', items, parameters);
        return input.db.prepare(`
          SELECT
            stage_runs.stage_run_id AS registered_stage_run_id,
            stage_runs.domain_id AS stage_run_domain_id,
            stage_runs.stage_id AS stage_run_stage_id,
            stage_runs.scope_kind AS stage_run_scope_kind,
            stage_runs.project_scope_id AS stage_run_project_scope_id,
            stage_runs.work_item_scope_id AS stage_run_work_item_scope_id,
            stage_runs.workspace_binding_id AS stage_run_workspace_binding_id,
            stage_runs.binding_version_id AS stage_run_binding_version_id,
            stage_runs.scope_digest AS stage_run_scope_digest,
            stage_runs.execution_scope_json AS stage_run_execution_scope_json,
            stage_runs.identity_state AS stage_run_identity_state,
            ${launchColumn('launch_status')} AS stage_run_launch_status,
            ${launchColumn('terminal_status')} AS stage_run_terminal_status,
            ${launchColumn('last_start_error')} AS stage_run_last_start_error,
            ${launchColumn('created_at')} AS stage_run_created_at,
            ${launchColumn('updated_at')} AS stage_run_updated_at
          FROM stage_run_launches AS stage_runs
          WHERE stage_runs.scope_kind = 'work_item'
            AND stage_runs.identity_state = 'resolved'
            AND (${predicate})
            AND NOT EXISTS (
              SELECT 1 FROM stage_attempts AS attempts
              WHERE attempts.stage_run_id = stage_runs.stage_run_id
            )
          ORDER BY stage_runs.updated_at DESC, stage_runs.stage_run_id DESC
        `).all(...parameters) as StageRunWithoutAttemptRow[];
      }).map(stageRunWithoutAttemptProjection)
    : [];
  const selectedAttempts = [...attempts, ...stageRunsWithoutAttempts];
  const qualityCycleIds = [...new Set(selectedAttempts
    .map((attempt) => stringValue(attempt.quality_cycle_id))
    .filter((value): value is string => Boolean(value)))];
  const qualityCycles = sqliteTableExists(input.db, 'stage_quality_cycles')
    ? batches(qualityCycleIds, ATTEMPT_DETAIL_BATCH_SIZE).flatMap((cycleIds) => (
        input.db.prepare(`
          SELECT * FROM stage_quality_cycles
          WHERE quality_cycle_id IN (${cycleIds.map(() => '?').join(', ')})
        `).all(...cycleIds) as Array<Record<string, unknown>>
      )).map((row): JsonRecord => ({
        ...row,
        policy: parseCompactRecord(row.policy_json),
        state: parseCompactRecord(row.state_json),
      }))
    : [];
  return { attempts: selectedAttempts, qualityCycles, diagnostics };
}

export function readWorkItemStageAttempts(
  scope?: WorkItemAttemptReadScope,
  options: { validateIrrelevantActivityJson?: boolean } = {},
) {
  const queueDb = path.join(resolveOplStatePaths().state_dir, 'family-runtime', 'queue.sqlite');
  if (!fs.existsSync(queueDb)) {
    return {
      queue_db: queueDb,
      attempts: [] as JsonRecord[],
      quality_cycles: [] as JsonRecord[],
      diagnostics: [] as WorkItemProjectionDiagnostic[],
    };
  }
  const db = openFamilyRuntimeSqlite(queueDb, { readOnly: true });
  try {
    const diagnostics: WorkItemProjectionDiagnostic[] = [];
    if (scope) {
      const scoped = readScopedWorkItemStageAttemptsFromDb({
        db,
        scope,
        validateIrrelevantActivityJson: options.validateIrrelevantActivityJson !== false,
      });
      return {
        queue_db: queueDb,
        attempts: scoped.attempts,
        quality_cycles: scoped.qualityCycles,
        diagnostics: scoped.diagnostics,
      };
    }
    const qualityCycleTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage_quality_cycles'",
    ).get();
    const qualityCycles = qualityCycleTable
      ? (db.prepare('SELECT * FROM stage_quality_cycles').all() as Array<Record<string, unknown>>).map((row) => {
          try {
            return {
              ...row,
              policy: JSON.parse(String(row.policy_json ?? '{}')),
              state: JSON.parse(String(row.state_json ?? '{}')),
            } as JsonRecord;
          } catch {
            return { ...row, policy: {}, state: {} } as JsonRecord;
          }
        })
      : [];
    const launchTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage_run_launches'",
    ).get();
    const stageRunLaunchById = new Map<string, JsonRecord>();
    if (launchTable) {
      const launchRows = db.prepare(`
        SELECT
          stage_run_id, stage_run_invocation_id, stage_run_spec_sha256,
          domain_id, stage_id, workflow_id, parent_route_decision_ref,
          stage_run_input_json, launch_status, terminal_status,
          last_start_error, created_at, updated_at
        FROM stage_run_launches
        WHERE EXISTS (
          SELECT 1 FROM stage_attempts
          WHERE stage_attempts.stage_run_id = stage_run_launches.stage_run_id
            AND stage_attempts.archived_at IS NULL
        )
        ORDER BY updated_at DESC, stage_run_id DESC
      `).all() as Array<Record<string, unknown>>;
      for (const row of launchRows) {
        const stageRunId = stringValue(row.stage_run_id);
        if (!stageRunId) continue;
        try {
          const stageRunInput = parseJsonText(String(row.stage_run_input_json ?? '{}'));
          if (!isRecord(stageRunInput)) throw new Error('stage_run_input_json is not an object');
          stageRunLaunchById.set(stageRunId, {
            surface_kind: 'opl_stage_run_launch_registry_entry',
            version: 'opl-stage-run-launch-registry-entry.v2',
            stage_run_id: stageRunId,
            stage_run_invocation_id: row.stage_run_invocation_id,
            stage_run_spec_sha256: row.stage_run_spec_sha256,
            domain_id: row.domain_id,
            stage_id: row.stage_id,
            workflow_id: row.workflow_id,
            parent_route_decision_ref: row.parent_route_decision_ref,
            stage_run_input: stageRunInput,
            launch_status: row.launch_status,
            terminal_status: row.terminal_status,
            last_start_error: row.last_start_error,
            created_at: row.created_at,
            updated_at: row.updated_at,
          });
        } catch (error) {
          if (diagnostics.length < MAX_DIAGNOSTIC_ATTEMPTS) {
            diagnostics.push({
              reason: 'stage_run_launch_projection_invalid',
              ref: stageRunId,
              details: { error: error instanceof Error ? error.message : String(error) },
            });
          }
        }
      }
    }
    const attempts = readWorkItemStageAttemptsFromDb(db).map((attempt) => {
      const stageRunId = stringValue(attempt.stage_run_id);
      const stageRunLaunch = stageRunId ? stageRunLaunchById.get(stageRunId) : null;
      return stageRunLaunch ? { ...attempt, stage_run_launch: stageRunLaunch } : attempt;
    });
    return {
      queue_db: queueDb,
      attempts,
      quality_cycles: qualityCycles,
      diagnostics,
    };
  } catch (error) {
    return {
      queue_db: queueDb,
      attempts: [] as JsonRecord[],
      quality_cycles: [] as JsonRecord[],
      diagnostics: [{
        reason: 'stage_attempt_ledger_read_failed',
        ref: queueDb,
        details: { error: error instanceof Error ? error.message : String(error) },
      }],
    };
  } finally {
    db.close();
  }
}
