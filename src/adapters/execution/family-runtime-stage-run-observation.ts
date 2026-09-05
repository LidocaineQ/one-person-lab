import { canonicalJsonText } from '../../kernel/canonical-json.ts';
import { isRecord } from '../../kernel/contract-validation.ts';

export const TERMINAL_STAGE_RUN_STATUSES = new Set([
  'completed',
  'completed_with_quality_debt',
  'blocked',
  'human_gate',
  'failed',
]);

export type StageRunObservation = {
  observed_at: string;
  workflow_id: string;
  stage_run_id: string | null;
  stage_id: string | null;
  status: string | null;
  current_role: string | null;
  attempt: Record<string, unknown> | null;
  latest_completed_attempt: Record<string, unknown> | null;
  artifact_refs: string[];
  quality_debt_refs: string[];
  route_quality_debt_refs: string[];
  selected_stage_route: Record<string, unknown> | null;
  next_workflow_id: string | null;
  blocked_reason: string | null;
  hard_stop_class: string | null;
  updated_at: string | null;
};

function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function summarizeStageRunObservation(value: unknown, workflowId: string, observedAt = new Date().toISOString()) {
  const state = isRecord(value) ? value : {};
  const attempts = Array.isArray(state.attempts)
    ? state.attempts.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] ?? null : null;
  const currentRole = stringOrNull(state.current_role);
  const nextLaunch = isRecord(state.next_stage_run_launch) ? state.next_stage_run_launch : {};
  const refs = (value: unknown) => Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    observed_at: observedAt,
    workflow_id: workflowId,
    stage_run_id: stringOrNull(state.stage_run_id),
    stage_id: stringOrNull(state.stage_id),
    status: stringOrNull(state.status),
    current_role: currentRole,
    attempt: currentRole && latestAttempt?.attempt_role !== currentRole ? null : latestAttempt,
    latest_completed_attempt: latestAttempt,
    artifact_refs: refs(state.artifact_refs),
    quality_debt_refs: refs(state.quality_debt_refs),
    route_quality_debt_refs: refs(state.route_quality_debt_refs),
    selected_stage_route: isRecord(state.selected_stage_route) ? state.selected_stage_route : null,
    next_workflow_id: stringOrNull(nextLaunch.target_workflow_id),
    blocked_reason: stringOrNull(state.blocked_reason),
    hard_stop_class: stringOrNull(state.hard_stop_class),
    updated_at: stringOrNull(state.updated_at),
  } satisfies StageRunObservation;
}

export function appendDistinctStageRunObservation(
  observations: StageRunObservation[],
  next: StageRunObservation,
) {
  const previous = observations[observations.length - 1];
  if (!previous || canonicalJsonText({ ...previous, observed_at: null }) !== canonicalJsonText({ ...next, observed_at: null })) {
    observations.push(next);
  }
  return observations;
}
