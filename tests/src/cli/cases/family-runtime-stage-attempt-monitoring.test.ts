import { DatabaseSync } from 'node:sqlite';

import {
  assert,
  createRuntimeWorkspaceFixture,
  fs,
  insertFamilyRuntimeTaskProjectionFixture,
  installRuntimePackageFixture,
  os,
  path,
  runCli,
  test,
} from '../helpers.ts';
import { listStageAttemptsWithMonitoringProjection } from '../../../../src/modules/runway/family-runtime-stage-attempt-monitoring.ts';

test('family-runtime compact timeline exposes filtered public currentness', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-attempt-monitoring-'));
  const env = {
    OPL_STATE_DIR: stateRoot,
    OPL_TEMPORAL_ADDRESS: '',
    TEMPORAL_ADDRESS: '',
  };
  try {
    installRuntimePackageFixture(stateRoot, 'redcube-ai');
    const workspaceRoot = createRuntimeWorkspaceFixture(stateRoot, 'redcube-runtime');
    const attempt = runCli([
      'family-runtime',
      'attempt',
      'create',
      '--domain',
      'redcube',
      '--stage',
      'scout',
      '--provider',
      'temporal',
      '--workspace-locator',
      JSON.stringify({ workspace_root: workspaceRoot, study_id: 'quest-artifact-owner' }),
      '--blocked-reason',
      'zero_readable_artifact',
    ], env).family_runtime_stage_attempt.attempt;
    const output = runCli([
      'family-runtime',
      'attempt',
      'list',
      '--domain',
      'redcube',
      '--study',
      'quest-artifact-owner',
      '--status',
      'blocked',
      '--compact-timeline',
    ], env).family_runtime_stage_attempts;
    const item = output.compact_timeline[0];

    assert.equal(output.view_mode, 'compact_timeline');
    assert.equal(output.summary.filtered_total, 1);
    assert.equal(item.stage_attempt_id, attempt.stage_attempt_id);
    assert.equal(item.current_provider_readiness.provider_ready, false);
    assert.equal(item.provider_liveness_attention.attention_status, 'blocked_provider_not_ready');
    assert.equal(
      item.provider_readiness_currentness.effective_provider_readiness_source,
      'current_provider_readiness',
    );
    assert.equal(item.provider_readiness_currentness.provider_receipt_is_current_readiness, false);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('family-runtime monitoring projection remains callable without the tasks table', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-attempt-monitoring-absence-'));
  const env = {
    OPL_STATE_DIR: stateRoot,
    OPL_TEMPORAL_ADDRESS: '',
    TEMPORAL_ADDRESS: '',
  };
  try {
    installRuntimePackageFixture(stateRoot, 'redcube-ai');
    const workspaceRoot = createRuntimeWorkspaceFixture(stateRoot, 'redcube-runtime');
    const task = insertFamilyRuntimeTaskProjectionFixture({
      stateRoot,
      domainId: 'redcube',
      taskKind: 'stage/scout',
      payload: { study_id: 'quest-artifact-owner' },
      dedupeKey: 'redcube:quest-artifact-owner:stage:scout',
    });
    runCli([
      'family-runtime',
      'attempt',
      'create',
      '--domain',
      'redcube',
      '--stage',
      'scout',
      '--provider',
      'temporal',
      '--workspace-locator',
      JSON.stringify({ workspace_root: workspaceRoot, study_id: 'quest-artifact-owner' }),
      '--task',
      task.task_id,
      '--blocked-reason',
      'zero_readable_artifact',
    ], env);

    const db = new DatabaseSync(path.join(stateRoot, 'family-runtime', 'queue.sqlite'));
    const previousStateRoot = process.env.OPL_STATE_DIR;
    process.env.OPL_STATE_DIR = stateRoot;
    try {
      db.exec('DROP TABLE tasks');
      const output = await listStageAttemptsWithMonitoringProjection(
        db,
        { root: path.join(stateRoot, 'family-runtime') },
        {},
        { domainId: 'redcube_ai', studyId: 'quest-artifact-owner', full: true },
      );
      assert.equal(output.summary.filtered_total, 1);
      assert.equal(output.attempts[0].study_id, 'quest-artifact-owner');
    } finally {
      if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
      else process.env.OPL_STATE_DIR = previousStateRoot;
      db.close();
    }
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
