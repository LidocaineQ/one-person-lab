import type { DatabaseSync } from 'node:sqlite';

const DEFAULT_RUNTIME_EVENT_RETENTION_MAX_COUNT = 50_000;
const DEFAULT_RUNTIME_NOTIFICATION_RETENTION_MAX_COUNT = 10_000;
const DEFAULT_RUNTIME_STAGE_ATTEMPT_CLOSEOUT_RETENTION_MAX_COUNT = 10_000;
const DEFAULT_RUNTIME_EVENT_RETENTION_MAX_AGE_DAYS = 30;
const DEFAULT_RUNTIME_NOTIFICATION_RETENTION_MAX_AGE_DAYS = 30;
const DEFAULT_RUNTIME_STAGE_ATTEMPT_CLOSEOUT_RETENTION_MAX_AGE_DAYS = 90;
const MAX_RUNTIME_HISTORY_PRUNE_ROWS_PER_TABLE_PER_PASS = 5_000;
const QUEUE_HISTORY_PRUNE_INTERVAL_MS = 60_000;
const recentQueueHistoryPrunes = new WeakMap<DatabaseSync, number>();

export type RuntimeQueueHistoryRetentionPolicy = {
  event_max_count: number;
  event_max_age_days: number;
  notification_max_count: number;
  notification_max_age_days: number;
  stage_attempt_closeout_max_count: number;
  stage_attempt_closeout_max_age_days: number;
};

function positiveIntegerEnvironmentValue(key: string, fallback: number) {
  const parsed = Number(process.env[key] ?? '');
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function runtimeQueueHistoryRetentionPolicy(): RuntimeQueueHistoryRetentionPolicy {
  return {
    event_max_count: positiveIntegerEnvironmentValue(
      'OPL_RUNTIME_EVENT_RETENTION_MAX_COUNT',
      DEFAULT_RUNTIME_EVENT_RETENTION_MAX_COUNT,
    ),
    event_max_age_days: positiveIntegerEnvironmentValue(
      'OPL_RUNTIME_EVENT_RETENTION_MAX_AGE_DAYS',
      DEFAULT_RUNTIME_EVENT_RETENTION_MAX_AGE_DAYS,
    ),
    notification_max_count: positiveIntegerEnvironmentValue(
      'OPL_RUNTIME_NOTIFICATION_RETENTION_MAX_COUNT',
      DEFAULT_RUNTIME_NOTIFICATION_RETENTION_MAX_COUNT,
    ),
    notification_max_age_days: positiveIntegerEnvironmentValue(
      'OPL_RUNTIME_NOTIFICATION_RETENTION_MAX_AGE_DAYS',
      DEFAULT_RUNTIME_NOTIFICATION_RETENTION_MAX_AGE_DAYS,
    ),
    stage_attempt_closeout_max_count: positiveIntegerEnvironmentValue(
      'OPL_RUNTIME_STAGE_ATTEMPT_CLOSEOUT_RETENTION_MAX_COUNT',
      DEFAULT_RUNTIME_STAGE_ATTEMPT_CLOSEOUT_RETENTION_MAX_COUNT,
    ),
    stage_attempt_closeout_max_age_days: positiveIntegerEnvironmentValue(
      'OPL_RUNTIME_STAGE_ATTEMPT_CLOSEOUT_RETENTION_MAX_AGE_DAYS',
      DEFAULT_RUNTIME_STAGE_ATTEMPT_CLOSEOUT_RETENTION_MAX_AGE_DAYS,
    ),
  };
}

function rowCount(db: DatabaseSync, table: 'events' | 'notifications' | 'stage_attempt_closeouts') {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function pruneTimestampedTable(
  db: DatabaseSync,
  input: {
    table: 'events' | 'notifications';
    idColumn: 'event_id' | 'notification_id';
    maxCount: number;
    maxAgeDays: number;
    nowMs: number;
  },
) {
  const before = rowCount(db, input.table);
  const maxAgeBefore = new Date(
    input.nowMs - input.maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  db.prepare(`
    DELETE FROM ${input.table}
    WHERE ${input.idColumn} IN (
      SELECT ${input.idColumn}
      FROM ${input.table}
      WHERE created_at < ?
        OR ${input.idColumn} IN (
          SELECT ${input.idColumn}
          FROM ${input.table}
          ORDER BY created_at DESC, ${input.idColumn} DESC
          LIMIT -1 OFFSET ?
        )
      ORDER BY created_at ASC, ${input.idColumn} ASC
      LIMIT ?
    )
  `).run(
    maxAgeBefore,
    input.maxCount,
    MAX_RUNTIME_HISTORY_PRUNE_ROWS_PER_TABLE_PER_PASS,
  );
  const retained = rowCount(db, input.table);
  const expired = (db.prepare(`
    SELECT COUNT(*) AS count FROM ${input.table} WHERE created_at < ?
  `).get(maxAgeBefore) as { count: number }).count;
  return {
    before,
    retained,
    pruned: before - retained,
    status: retained <= input.maxCount && expired === 0 ? 'bounded' : 'prune_in_progress',
  };
}

function pruneStageAttemptCloseoutHistory(
  db: DatabaseSync,
  input: {
    maxCount: number;
    maxAgeDays: number;
    nowMs: number;
  },
) {
  const maxAgeBefore = new Date(
    input.nowMs - input.maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const terminalStatusSql = "'completed', 'failed', 'dead_lettered'";
  const terminalRowCount = () => (db.prepare(`
    SELECT COUNT(*) AS count
    FROM stage_attempt_closeouts AS closeout
    JOIN stage_attempts AS attempt
      ON attempt.stage_attempt_id = closeout.stage_attempt_id
    WHERE attempt.status IN (${terminalStatusSql})
  `).get() as { count: number }).count;
  const before = terminalRowCount();
  db.prepare(`
    DELETE FROM stage_attempt_closeouts
    WHERE closeout_id IN (
      SELECT closeout.closeout_id
      FROM stage_attempt_closeouts AS closeout
      JOIN stage_attempts AS attempt
        ON attempt.stage_attempt_id = closeout.stage_attempt_id
      WHERE attempt.status IN (${terminalStatusSql})
        AND (
          closeout.created_at < ?
          OR closeout.closeout_id IN (
            SELECT retained.closeout_id
            FROM stage_attempt_closeouts AS retained
            JOIN stage_attempts AS retained_attempt
              ON retained_attempt.stage_attempt_id = retained.stage_attempt_id
            WHERE retained_attempt.status IN (${terminalStatusSql})
            ORDER BY retained.created_at DESC, retained.closeout_id DESC
            LIMIT -1 OFFSET ?
          )
        )
      ORDER BY closeout.created_at ASC, closeout.closeout_id ASC
      LIMIT ?
    )
  `).run(
    maxAgeBefore,
    input.maxCount,
    MAX_RUNTIME_HISTORY_PRUNE_ROWS_PER_TABLE_PER_PASS,
  );
  const retained = terminalRowCount();
  const expired = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM stage_attempt_closeouts AS closeout
    JOIN stage_attempts AS attempt
      ON attempt.stage_attempt_id = closeout.stage_attempt_id
    WHERE attempt.status IN (${terminalStatusSql})
      AND closeout.created_at < ?
  `).get(maxAgeBefore) as { count: number }).count;
  return {
    before,
    retained,
    pruned: before - retained,
    status: retained <= input.maxCount && expired === 0 ? 'bounded' : 'prune_in_progress',
  };
}

export function pruneRuntimeQueueHistory(
  db: DatabaseSync,
  policy = runtimeQueueHistoryRetentionPolicy(),
  nowMs = Date.now(),
) {
  const events = pruneTimestampedTable(db, {
    table: 'events',
    idColumn: 'event_id',
    maxCount: policy.event_max_count,
    maxAgeDays: policy.event_max_age_days,
    nowMs,
  });
  const notifications = pruneTimestampedTable(db, {
    table: 'notifications',
    idColumn: 'notification_id',
    maxCount: policy.notification_max_count,
    maxAgeDays: policy.notification_max_age_days,
    nowMs,
  });
  const stageAttemptCloseouts = pruneStageAttemptCloseoutHistory(db, {
    maxCount: policy.stage_attempt_closeout_max_count,
    maxAgeDays: policy.stage_attempt_closeout_max_age_days,
    nowMs,
  });
  return {
    policy,
    events,
    notifications,
    stage_attempt_closeouts: stageAttemptCloseouts,
  };
}

export function maybePruneRuntimeQueueHistory(db: DatabaseSync) {
  const nowMs = Date.now();
  const previous = recentQueueHistoryPrunes.get(db) ?? 0;
  if (nowMs - previous < QUEUE_HISTORY_PRUNE_INTERVAL_MS) {
    return;
  }
  pruneRuntimeQueueHistory(db, undefined, nowMs);
  recentQueueHistoryPrunes.set(db, nowMs);
}
