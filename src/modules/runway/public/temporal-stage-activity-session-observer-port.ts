type WorkItemExecutionScope = {
  domain_id?: unknown;
  domain_work_item_id?: unknown;
  project_scope_id?: unknown;
  work_item_scope_id?: unknown;
  workspace_binding_id?: unknown;
};

export type TemporalStageActivitySessionObserverInput = {
  stage_attempt_id: string;
  workflow_id: string;
  domain_id: string;
  execution_scope?: WorkItemExecutionScope | null;
};

export type TemporalStageActivityRunnerEvent = {
  event_kind: string;
  value?: string | null;
};

export type TemporalStageActivitySessionTerminalState = 'completed' | 'failed' | 'cancelled';

export type TemporalStageActivitySessionObservationResult = {
  surface_kind: 'opl_temporal_stage_activity_session_observation_result';
  event_kind: 'start' | 'heartbeat' | 'terminal' | 'ignored';
  status: 'applied' | 'unchanged' | 'skipped' | 'failed';
  activity_state: 'running' | 'waiting' | TemporalStageActivitySessionTerminalState | null;
  execution_session_ref: string | null;
  receipt_ref: string | null;
  observed_at: string | null;
  sequence: number | null;
  reason: string | null;
  failure_code: string | null;
};

export type TemporalStageActivitySessionObservationSummary = {
  surface_kind: 'opl_temporal_stage_activity_session_observation_summary';
  schema_version: 'opl-temporal-stage-activity-session-observation-summary.v1';
  status: 'not_started' | 'active' | 'terminal' | 'degraded';
  stage_attempt_ref: string;
  workflow_ref: string;
  execution_session_ref: string | null;
  latest_receipt_ref: string | null;
  latest_activity_state: 'running' | 'waiting' | TemporalStageActivitySessionTerminalState | null;
  terminal_state: TemporalStageActivitySessionTerminalState | null;
  emitted_event_count: number;
  heartbeat_count: number;
  failure_codes: string[];
  authority_boundary: {
    projection_only: true;
    coordination_is_execution_proof: false;
    can_change_stage_attempt: false;
    can_change_work_item_lifecycle: false;
    can_write_domain_truth: false;
  };
};

export type TemporalStageActivitySessionObserver = {
  onRunnerProgress: (
    event: TemporalStageActivityRunnerEvent,
  ) => TemporalStageActivitySessionObservationResult;
  heartbeat: () => TemporalStageActivitySessionObservationResult;
  terminal: (
    state: TemporalStageActivitySessionTerminalState,
  ) => TemporalStageActivitySessionObservationResult;
  summary: () => TemporalStageActivitySessionObservationSummary;
};

export type TemporalStageActivitySessionObserverFactory = (
  input: TemporalStageActivitySessionObserverInput,
) => TemporalStageActivitySessionObserver;

let registeredFactory: TemporalStageActivitySessionObserverFactory | null = null;

export function registerTemporalStageActivitySessionObserverFactory(
  factory: TemporalStageActivitySessionObserverFactory,
) {
  if (registeredFactory && registeredFactory !== factory) {
    throw new Error('Temporal stage activity session observer factory is already registered.');
  }
  registeredFactory = factory;
}

export function temporalStageActivitySessionObserverFactoryRegistered() {
  return registeredFactory !== null;
}

function unregisteredObserver(
  input: TemporalStageActivitySessionObserverInput,
): TemporalStageActivitySessionObserver {
  let observationRequested = false;
  const skipped = (
    eventKind: TemporalStageActivitySessionObservationResult['event_kind'],
    reason: string,
  ): TemporalStageActivitySessionObservationResult => ({
    surface_kind: 'opl_temporal_stage_activity_session_observation_result',
    event_kind: eventKind,
    status: 'skipped',
    activity_state: null,
    execution_session_ref: null,
    receipt_ref: null,
    observed_at: null,
    sequence: null,
    reason,
    failure_code: observationRequested
      ? 'temporal_stage_activity_session_observer_unregistered'
      : null,
  });
  return {
    onRunnerProgress(event) {
      if (event.event_kind === 'thread.started') observationRequested = true;
      return skipped(
        event.event_kind === 'thread.started' ? 'start' : 'ignored',
        'temporal_stage_activity_session_observer_unregistered',
      );
    },
    heartbeat() {
      return skipped('heartbeat', 'execution_session_not_started');
    },
    terminal() {
      return skipped('terminal', 'execution_session_not_started');
    },
    summary() {
      return {
        surface_kind: 'opl_temporal_stage_activity_session_observation_summary',
        schema_version: 'opl-temporal-stage-activity-session-observation-summary.v1',
        status: observationRequested ? 'degraded' : 'not_started',
        stage_attempt_ref: `opl://stage_attempts/${encodeURIComponent(input.stage_attempt_id)}`,
        workflow_ref: `temporal://workflows/${encodeURIComponent(input.workflow_id)}`,
        execution_session_ref: null,
        latest_receipt_ref: null,
        latest_activity_state: null,
        terminal_state: null,
        emitted_event_count: 0,
        heartbeat_count: 0,
        failure_codes: observationRequested
          ? ['temporal_stage_activity_session_observer_unregistered']
          : [],
        authority_boundary: {
          projection_only: true,
          coordination_is_execution_proof: false,
          can_change_stage_attempt: false,
          can_change_work_item_lifecycle: false,
          can_write_domain_truth: false,
        },
      };
    },
  };
}

export function createTemporalStageActivitySessionObserverFromPort(
  input: TemporalStageActivitySessionObserverInput,
) {
  return registeredFactory?.(input) ?? unregisteredObserver(input);
}
