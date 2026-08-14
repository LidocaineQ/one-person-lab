import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MockActivityEnvironment } from '@temporalio/testing';

import {
  CORDIS_FIBER_STATE,
} from '../../src/modules/runway/cordis-agent-executor-experiment.ts';
import {
  cordisRunwayAttemptObserverPlugin,
  createCordisRunwayAttemptComposition,
  type CordisRunwayAttemptAdapter,
} from '../../src/modules/runway/cordis-runway-attempt.ts';
import {
  runAgentStageRunner,
  type CodexStageRunnerInput,
} from '../../src/modules/runway/family-runtime-codex-stage-runner.ts';
import { codexStageActivity } from '../../src/modules/runway/family-runtime-temporal-activities.ts';
import { createPersistedTemporalStageAttemptInput } from './family-runtime-temporal-provider-cases/persisted-attempt.ts';

test('Runway attempt Cordis service consumes the adapter and fully disposes its scope', async () => {
  const requests: string[] = [];
  const results: string[] = [];
  const adapter: CordisRunwayAttemptAdapter = {
    id: 'fixture-attempt-adapter',
    async execute(input) {
      requests.push(String(input.attempt.stage_attempt_id));
      return {
        runner_status: {
          runner_kind: 'fixture',
          runner_mode: 'dry_run',
          live_process_started: false,
          dry_run_transport: true,
          process_id: null,
          exit_code: 0,
          stdout_bytes: 0,
          stderr_bytes: 0,
          timeout_ms: null,
          no_output_timeout_ms: null,
          command_preview: [],
          effective_prompt: {
            status: 'fixture',
            source_manifest_ref: null,
            source_ref: null,
            layer: null,
            sha256: null,
            size_bytes: 0,
            body_hydrated_into_executor_prompt: false,
          },
          typed_closeout_required_for_progress: false,
          raw_artifact_sufficient_for_progress: true,
        },
        heartbeat_summary: {
          heartbeat_status: 'recorded',
          last_heartbeat_at: null,
          checkpoint_count: 0,
          checkpoint_refs: [],
        },
        progress_summary: {
          progress_status: 'running',
          stage_id: 'fixture',
          stage_packet_ref: null,
          progress_requires_typed_closeout: false,
          raw_artifact_sufficient_for_progress: true,
          thread_id: null,
          execution_session_ref: null,
          runner_events: [],
        },
        cost_summary: {
          surface_kind: 'opl_codex_stage_runner_cost_summary',
          runner_mode: 'dry_run',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          usage_available: false,
          usage_source: null,
          session_usage_ref: null,
        },
        closeout_packet: null,
      } as never;
    },
  };
  const composition = await createCordisRunwayAttemptComposition({
    attemptRef: 'opl://stage-attempts/fixture',
    adapter,
  });
  const observerFiber = await composition.ctx.plugin(cordisRunwayAttemptObserverPlugin, {
    onRequest: (input) => requests.push(`requested:${String(input.attempt.stage_attempt_id)}`),
    onResult: async (receipt) => {
      results.push(receipt.runner_status.runner_kind);
    },
  });
  try {
    assert.equal(composition.executorFiber.state, CORDIS_FIBER_STATE.ACTIVE);
    await composition.executor.execute({ attempt: { stage_attempt_id: 'fixture' } });
    assert.deepEqual(requests, ['requested:fixture', 'fixture']);
    assert.deepEqual(results, ['fixture']);
    assert.equal(composition.snapshot.binding.executor_route, 'opl.runway.attempt.executor');
  } finally {
    await observerFiber.dispose();
    await composition.dispose();
  }
  assert.equal(composition.executorFiber.state, 4);
  assert.equal(composition.adapterFiber.state, 4);
  assert.equal(composition.ctx.fiber.state, CORDIS_FIBER_STATE.ACTIVE);
  assert.equal(composition.ctx.get('opl.runway.attempt.executor'), undefined);
  assert.equal(composition.ctx.get('opl.runway.attempt.adapter'), undefined);
});

test('codexStageActivity uses an attempt-scoped Cordis composition without changing runner receipt or heartbeats', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-cordis-runway-attempt-state-'));
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = stateRoot;
  const environment = new MockActivityEnvironment({
    activityType: 'codexStageActivity',
    activityId: 'cordis-runway-attempt-test',
    workflowExecution: { workflowId: 'wf-cordis-runway-attempt', runId: 'run-cordis-runway-attempt' },
  });
  const heartbeats: unknown[] = [];
  let activityComposition: Awaited<ReturnType<typeof createCordisRunwayAttemptComposition>> | null = null;
  let consumedRunnerInput: CodexStageRunnerInput | null = null;
  environment.on('heartbeat', (details) => heartbeats.push(details));
  try {
    const input = createPersistedTemporalStageAttemptInput({
      fixtureId: 'cordis-runway-attempt',
      checkpointRefs: ['checkpoint:cordis-runway-attempt'],
    });
    const result = await environment.run(
      codexStageActivity,
      input,
      {
        async createAttemptComposition(
          options: Parameters<typeof createCordisRunwayAttemptComposition>[0],
        ) {
          activityComposition = await createCordisRunwayAttemptComposition({
            ...options,
            adapter: {
              id: 'activity-injected-existing-runner',
              async execute(runnerInput) {
                consumedRunnerInput = runnerInput;
                return await runAgentStageRunner(runnerInput);
              },
            },
          });
          return activityComposition;
        },
      },
    ) as Record<string, any>;
    assert.equal(result.activity_kind, 'codex_stage_activity');
    assert.equal(result.runner_status?.runner_mode, 'dry_run');
    assert.equal(result.cordis_attempt_composition, undefined);
    assert.equal(
      (activityComposition as Awaited<ReturnType<typeof createCordisRunwayAttemptComposition>> | null)
        ?.attemptRef,
      `opl://stage-attempts/${encodeURIComponent(input.stage_attempt_id)}`,
    );
    assert.equal(
      (activityComposition as Awaited<ReturnType<typeof createCordisRunwayAttemptComposition>> | null)
        ?.snapshot.binding.executor_route,
      'opl.runway.attempt.executor',
    );
    assert.ok(
      (activityComposition as Awaited<ReturnType<typeof createCordisRunwayAttemptComposition>> | null)
        ?.snapshot.snapshot_id.startsWith('cordis:snapshot:'),
    );
    assert.ok(heartbeats.length >= 1);
    assert.equal(
      (consumedRunnerInput as CodexStageRunnerInput | null)?.signal,
      environment.context.cancellationSignal,
    );
    assert.equal(
      typeof (consumedRunnerInput as CodexStageRunnerInput | null)?.onRunnerProgress,
      'function',
    );
    assert.equal(
      (activityComposition as Awaited<ReturnType<typeof createCordisRunwayAttemptComposition>> | null)
        ?.executorFiber.state,
      4,
    );
    assert.equal(
      (activityComposition as Awaited<ReturnType<typeof createCordisRunwayAttemptComposition>> | null)
        ?.adapterFiber.state,
      4,
    );
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
