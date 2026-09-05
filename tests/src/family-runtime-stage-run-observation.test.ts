import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runFamilyRuntime } from '../../src/adapters/execution/family-runtime.ts';
import { summarizeStageRunObservation } from '../../src/adapters/execution/family-runtime-stage-run-observation.ts';

test('watch emits progress before completion and follows quality-debt handoffs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-stage-watch-'));
  const priorState = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = root;
  t.after(() => {
    if (priorState === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = priorState;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const observations: ReturnType<typeof summarizeStageRunObservation>[] = [];
  const queries: string[] = [];
  const result = await runFamilyRuntime(['stage-run', 'watch', 'wf:first', '--interval-ms', '1'], {
    onStageRunObservation: (observation) => observations.push(observation),
    stageRunRuntime: {
      async queryWorkflow({ workflowId }) {
        queries.push(workflowId);
        if (queries.length === 2) assert.equal(observations.length, 1);
        return {
          workflow_id: workflowId,
          stage_id: workflowId === 'wf:first' ? 'draft' : 'delivery',
          status: queries.length === 1 ? 'running' : workflowId === 'wf:first'
            ? 'completed_with_quality_debt' : 'completed',
          next_stage_run_launch: queries.length === 2 ? { target_workflow_id: 'wf:second' } : null,
          artifact_refs: ['file:///draft.md'],
          quality_debt_refs: ['quality-debt:review-unavailable'],
        };
      },
    },
  });
  assert.deepEqual(queries, ['wf:first', 'wf:first', 'wf:second']);
  assert.equal(observations.length, 3);
  assert.equal(observations[1]?.next_workflow_id, 'wf:second');
  const watch = result.family_runtime_stage_run_watch as Record<string, unknown>;
  assert.equal(watch.terminal, true);
  assert.equal(watch.timed_out, false);
  assert.equal(watch.current_workflow_id, 'wf:second');
});

test('observation distinguishes active role from the last finished Attempt', () => {
  const completedProducer = { attempt_role: 'producer', stage_attempt_id: 'sat:producer', status: 'completed' };
  const observation = summarizeStageRunObservation({
    status: 'running', current_role: 'reviewer', attempts: [completedProducer],
    artifact_refs: ['file:///draft.md'],
  }, 'wf:review');
  assert.equal(observation.attempt, null);
  assert.equal(observation.current_role, 'reviewer');
  assert.deepEqual(observation.latest_completed_attempt, completedProducer);
  assert.deepEqual(observation.artifact_refs, ['file:///draft.md']);
});
