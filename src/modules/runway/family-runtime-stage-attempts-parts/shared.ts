import crypto from 'node:crypto';

import { FrameworkContractError } from '../../../kernel/contract-validation.ts';
import type { StageAttemptRow } from '../family-runtime-stage-attempt-ledger.ts';
import {
  parseStageAttemptJsonList,
} from '../family-runtime-stage-attempt-ledger.ts';

export const MAX_STAGE_ATTEMPT_ACTIVITY_EVENTS = 256;
export const MAX_STAGE_ATTEMPT_ACTIVITY_EVENT_BYTES = 16 * 1024;
export const MAX_STAGE_ATTEMPT_PERSISTED_JSON_BYTES = 64 * 1024;
const ACTIVITY_COMPACTION_EVENT_KIND = 'stage_attempt_activity_history_compacted';
const ACTIVITY_TRUNCATION_EVENT_KIND = 'stage_attempt_activity_event_truncated';

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStageId(stageId: string) {
  const normalized = stageId.trim();
  if (!normalized) {
    throw new Error('Stage attempt requires a non-empty stage id.');
  }
  return normalized;
}

export function normalizeJsonList(value?: string[]) {
  return Array.isArray(value) ? value.filter((entry) => entry.trim()).map((entry) => entry.trim()) : [];
}

function normalizeActivityEvent(value: Record<string, unknown>) {
  return {
    event_time: nowIso(),
    ...value,
  };
}

function isActivityEvent(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringifyBoundedStageAttemptJson(
  value: unknown,
  field: string,
  maxBytes = MAX_STAGE_ATTEMPT_PERSISTED_JSON_BYTES,
) {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maxBytes) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      `${field} exceeds the persisted StageAttempt JSON byte limit.`,
      {
        failure_code: 'stage_attempt_persisted_json_too_large',
        field,
        max_json_bytes: maxBytes,
        actual_json_bytes: bytes,
        sha256: crypto.createHash('sha256').update(serialized).digest('hex'),
      },
    );
  }
  return serialized;
}

function boundedActivityEvent(event: Record<string, unknown>) {
  const serialized = JSON.stringify(event);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= MAX_STAGE_ATTEMPT_ACTIVITY_EVENT_BYTES) {
    return event;
  }
  const eventTime = typeof event.event_time === 'string' ? event.event_time : nowIso();
  const originalEventKind = typeof event.event_kind === 'string'
    ? event.event_kind
    : typeof event.activity_kind === 'string'
      ? event.activity_kind
      : null;
  return {
    event_kind: ACTIVITY_TRUNCATION_EVENT_KIND,
    event_time: eventTime,
    original_event_kind: originalEventKind,
    original_json_bytes: bytes,
    sha256: crypto.createHash('sha256').update(serialized).digest('hex'),
    retention_policy: {
      strategy: 'hash_and_size_only',
      max_event_json_bytes: MAX_STAGE_ATTEMPT_ACTIVITY_EVENT_BYTES,
    },
  };
}

function compactedEventCount(event: Record<string, unknown>) {
  if (event.event_kind !== ACTIVITY_COMPACTION_EVENT_KIND) {
    return 0;
  }
  const count = event.compacted_event_count;
  return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export function compactStageAttemptActivityEvents(
  values: unknown[],
  compactedAt = nowIso(),
) {
  const activityEvents = values.filter(isActivityEvent).map(boundedActivityEvent);
  const previouslyCompactedCount = activityEvents.reduce(
    (total, event) => total + compactedEventCount(event),
    0,
  );
  const retainedCandidates = activityEvents.filter(
    (event) => event.event_kind !== ACTIVITY_COMPACTION_EVENT_KIND,
  );
  if (
    previouslyCompactedCount === 0
    && retainedCandidates.length <= MAX_STAGE_ATTEMPT_ACTIVITY_EVENTS
  ) {
    return retainedCandidates;
  }
  const retainedEventLimit = MAX_STAGE_ATTEMPT_ACTIVITY_EVENTS - 1;
  const newlyCompactedCount = Math.max(0, retainedCandidates.length - retainedEventLimit);
  const retainedEvents = retainedCandidates.slice(-retainedEventLimit);
  return [{
    event_kind: ACTIVITY_COMPACTION_EVENT_KIND,
    event_time: compactedAt,
    compacted_event_count: previouslyCompactedCount + newlyCompactedCount,
    retained_event_count: retainedEvents.length,
    retention_policy: {
      strategy: 'latest_tail',
      max_events: MAX_STAGE_ATTEMPT_ACTIVITY_EVENTS,
    },
  }, ...retainedEvents];
}

export function appendActivityEventToRow(row: StageAttemptRow, event: Record<string, unknown>) {
  return compactStageAttemptActivityEvents([
    ...parseStageAttemptJsonList(row.activity_events_json).filter(
      isActivityEvent,
    ),
    normalizeActivityEvent(event),
  ], typeof event.event_time === 'string' ? event.event_time : undefined);
}
