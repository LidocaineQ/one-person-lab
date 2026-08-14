import {
  assert,
  fs,
  os,
  path,
  test,
} from '../helpers.ts';
import {
  buildAppOperatorDrilldown,
} from '../../../../src/modules/console/runtime-tray-app-operator-drilldown.ts';
import { buildCurrentOwnerDeltaTopline } from '../../../../src/modules/ledger/current-owner-delta-topline.ts';

const ownerDeltaObserver = { observe: buildCurrentOwnerDeltaTopline };

test('runtime tray App drilldown retains progress, action, evidence, and readiness surfaces', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-tray-app-drilldown-surfaces-'));
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = stateRoot;
  try {
    const projection = buildAppOperatorDrilldown({
      stageAttemptWorkbench: {
        attempts: [],
        stage_progress_log: {
          attempt_refs: ['/stage_attempt_workbench/attempts/example/stage_progress_log'],
          temporal_webui_ref_count: 1,
          activity_event_count: 2,
        },
      },
      providerContinuousProof: {},
      domainProjectionIngestion: {},
      domainManifestProjects: [],
      detailLevel: 'full',
      ownerDeltaObserver,
    });

    assert.deepEqual(
      projection.stage_progress_log.attempt_refs,
      ['/stage_attempt_workbench/attempts/example/stage_progress_log'],
    );
    assert.equal(projection.stage_progress_log.temporal_webui_ref_count, 1);
    assert.equal(projection.stage_progress_log.activity_event_count, 2);
    assert.equal(Array.isArray(projection.operator_action_routing_refs.refs), true);
    assert.equal(projection.evidence_envelope.surface_kind, 'opl_evidence_envelope_projection');
    assert.equal(projection.evidence_envelope.authority_boundary.can_read_artifact_body, false);
    assert.equal(projection.quality_readiness_refs.surface_kind, 'opl_app_drilldown_quality_readiness_refs');
    assert.equal(projection.authority_boundary.can_authorize_quality_verdict, false);
    assert.equal(projection.authority_boundary.can_read_artifact_body, false);
    assert.equal(projection.runtime_workbench.memory_trace_projection.authority_boundary.can_read_memory_body, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
