import type { DatabaseSync } from 'node:sqlite';

import { FrameworkContractError } from '../../kernel/contract-validation.ts';
import {
  insertEvent,
  insertNotification,
} from './family-runtime-store.ts';
import {
  getStageAttemptRow,
  parseStageAttemptJsonObject,
  type StageAttemptRow,
} from './family-runtime-stage-attempt-ledger.ts';
import { requireRuntimeExecutionScopeMutationAllowed } from './family-runtime-execution-scope-persistence.ts';
import {
  isStageNativeOwnerActionFromDomainProfile,
  stageAttemptRowHasStageNativeProgressOrOwnerAnswerFromDomainProfile,
} from './family-runtime-stage-native-owner-answer.ts';

function linkedDefaultExecutorPayload(row: StageAttemptRow) {
  if (!row.task_id || row.executor_kind !== 'codex_cli') {
    return null;
  }
  const payload = parseStageAttemptJsonObject(row.workspace_locator_json);
  return isStageNativeOwnerActionFromDomainProfile({
    row: {
      domain_id: row.domain_id,
      task_kind: row.stage_id,
    },
    payload,
  }) ? payload : null;
}

function laterAttemptPredicate() {
  return `
    (
      created_at > @created_at
      OR (created_at = @created_at AND rowid > (
        SELECT rowid FROM stage_attempts WHERE stage_attempt_id = @stage_attempt_id
      ))
    )
  `;
}

function hasLaterLinkedAttempt(
  db: DatabaseSync,
  row: StageAttemptRow,
) {
  if (!row.task_id) {
    return false;
  }
  const newerAttempt = db.prepare(`
    SELECT stage_attempt_id
    FROM stage_attempts
    WHERE task_id = @task_id AND stage_attempt_id != @stage_attempt_id
      AND ${laterAttemptPredicate()}
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get({
    task_id: row.task_id,
    stage_attempt_id: row.stage_attempt_id,
    created_at: row.created_at,
  }) as { stage_attempt_id: string } | undefined;
  return Boolean(newerAttempt);
}

function hasLaterAcceptedCloseoutAttempt(
  db: DatabaseSync,
  row: StageAttemptRow,
) {
  if (!row.task_id) {
    return false;
  }
  const newerCloseout = db.prepare(`
    SELECT stage_attempt_id
    FROM stage_attempts
    WHERE task_id = @task_id AND stage_attempt_id != @stage_attempt_id
      AND status = 'completed' AND closeout_receipt_status = 'accepted_typed_closeout'
      AND ${laterAttemptPredicate()}
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get({
    task_id: row.task_id,
    stage_attempt_id: row.stage_attempt_id,
    created_at: row.created_at,
  }) as { stage_attempt_id: string } | undefined;
  return Boolean(newerCloseout);
}

function terminalEventAlreadyWritten(
  db: DatabaseSync,
  row: StageAttemptRow,
  eventType: string,
) {
  return Boolean(row.task_id && db.prepare(`
    SELECT 1
    FROM events
    WHERE task_id = ? AND event_type = ?
      AND json_extract(payload_json, '$.stage_attempt_id') = ?
    LIMIT 1
  `).get(row.task_id, eventType, row.stage_attempt_id));
}

function withAdmittedDurableStageAttempt<T>(
  db: DatabaseSync,
  stageAttemptId: string,
  operation: string,
  mutation: (row: StageAttemptRow) => T,
) {
  const ownsTransaction = !db.isTransaction;
  try {
    if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
    const row = getStageAttemptRow(db, stageAttemptId);
    if (!row) {
      throw new FrameworkContractError('contract_shape_invalid', 'Stage attempt is not persisted.', {
        failure_code: 'persisted_runtime_stage_attempt_not_found',
        operation,
        stage_attempt_id: stageAttemptId,
      });
    }
    requireRuntimeExecutionScopeMutationAllowed(db, row, operation);
    const result = mutation(row);
    if (ownsTransaction) db.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function markLinkedDefaultExecutorTaskCompletedForDurableRow(
  db: DatabaseSync,
  input: {
    row: StageAttemptRow;
    observedAt: string;
  },
) {
  const row = input.row;
  const payload = linkedDefaultExecutorPayload(row);
  if (
    !payload
    || hasLaterLinkedAttempt(db, row)
    || row.status !== 'completed'
    || !row.closeout_receipt_status
    || terminalEventAlreadyWritten(db, row, 'stage_attempt_terminal_completed_task')
  ) {
    return;
  }
  const missingRecognizedEnvelope = !stageAttemptRowHasStageNativeProgressOrOwnerAnswerFromDomainProfile({
    row,
    currentPayload: payload,
  });
  insertEvent(db, {
    taskId: row.task_id,
    domainId: row.domain_id,
    eventType: 'stage_attempt_terminal_completed_task',
    source: 'opl-family-runtime',
    payload: {
      stage_attempt_id: row.stage_attempt_id,
      workflow_id: row.workflow_id,
      reason: 'temporal_stage_attempt_completed',
      provider_status: parseStageAttemptJsonObject(row.provider_run_json).provider_status ?? null,
      ...(missingRecognizedEnvelope
        ? {
            quality_debt: 'stage_native_progress_envelope_missing_but_provider_attempt_completed',
            next_stage_blocked: false,
            framework_should_derive_progress_envelope: true,
          }
        : {}),
      authority_boundary: {
        opl: 'provider_attempt_status_projection_only',
        domain: 'truth_quality_artifact_gate_owner',
        provider_completion_is_domain_ready: false,
      },
    },
  });
  insertNotification(db, {
    taskId: row.task_id,
    severity: missingRecognizedEnvelope ? 'warning' : 'info',
    title: missingRecognizedEnvelope
      ? 'Family runtime attempt completed with derived progress debt'
      : 'Family runtime default executor attempt completed',
    body: row.stage_attempt_id,
    payload: {
      stage_attempt_id: row.stage_attempt_id,
      reason: 'temporal_stage_attempt_completed',
      ...(missingRecognizedEnvelope
        ? { quality_debt: 'stage_native_progress_envelope_missing_nonblocking' }
        : {}),
    },
  });
}

export function markLinkedDefaultExecutorTaskCompleted(
  db: DatabaseSync,
  input: {
    row: StageAttemptRow;
    observedAt: string;
  },
) {
  return withAdmittedDurableStageAttempt(
    db,
    input.row.stage_attempt_id,
    'mark_linked_default_executor_task_completed',
    (row) => markLinkedDefaultExecutorTaskCompletedForDurableRow(db, {
      ...input,
      row,
    }),
  );
}

function blockLinkedDefaultExecutorTaskForDurableRow(
  db: DatabaseSync,
  input: {
    row: StageAttemptRow;
    reason: string;
    observedAt: string;
    taskDeadLetterReason:
      | 'temporal_stage_attempt_failed'
      | 'temporal_stage_attempt_not_completed'
      | 'temporal_stage_attempt_start_failed'
      | 'temporal_stage_attempt_canceled';
    eventType: string;
  },
) {
  const row = input.row;
  if (
    !linkedDefaultExecutorPayload(row)
    || hasLaterLinkedAttempt(db, row)
    || hasLaterAcceptedCloseoutAttempt(db, row)
    || !['blocked', 'failed'].includes(row.status)
    || row.blocked_reason !== input.reason
    || terminalEventAlreadyWritten(db, row, input.eventType)
  ) {
    return;
  }
  insertEvent(db, {
    taskId: row.task_id,
    domainId: row.domain_id,
    eventType: input.eventType,
    source: 'opl-family-runtime',
    payload: {
      stage_attempt_id: row.stage_attempt_id,
      workflow_id: row.workflow_id,
      reason: input.reason,
      task_dead_letter_reason: input.taskDeadLetterReason,
      provider_status: parseStageAttemptJsonObject(row.provider_run_json).provider_status ?? null,
      authority_boundary: {
        opl: 'provider_attempt_status_projection_only',
        domain: 'truth_quality_artifact_gate_owner',
        provider_completion_is_domain_ready: false,
      },
    },
  });
  insertNotification(db, {
    taskId: row.task_id,
    severity: 'error',
    title: 'Family runtime default executor attempt blocked',
    body: input.reason,
    payload: {
      stage_attempt_id: row.stage_attempt_id,
      reason: input.reason,
      task_dead_letter_reason: input.taskDeadLetterReason,
    },
  });
}

export function blockLinkedDefaultExecutorTask(
  db: DatabaseSync,
  input: {
    row: StageAttemptRow;
    reason: string;
    observedAt: string;
    taskDeadLetterReason:
      | 'temporal_stage_attempt_failed'
      | 'temporal_stage_attempt_not_completed'
      | 'temporal_stage_attempt_start_failed'
      | 'temporal_stage_attempt_canceled';
    eventType: string;
  },
) {
  return withAdmittedDurableStageAttempt(
    db,
    input.row.stage_attempt_id,
    'block_linked_default_executor_task',
    (row) => blockLinkedDefaultExecutorTaskForDurableRow(db, {
      ...input,
      row,
    }),
  );
}
