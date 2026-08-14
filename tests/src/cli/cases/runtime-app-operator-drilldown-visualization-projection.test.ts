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

test('runtime App drilldown retains the canonical workbench shell', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-app-drilldown-workbench-shell-'));
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = stateRoot;
  try {
    const projection = buildAppOperatorDrilldown({
      stageAttemptWorkbench: { attempts: [] },
      providerContinuousProof: {},
      domainProjectionIngestion: {},
      domainManifestProjects: [],
      detailLevel: 'full',
      ownerDeltaObserver,
    });

    assert.equal(projection.detail_level, 'full');
    assert.equal(projection.surface_kind, 'opl_app_operator_drilldown_read_model');
    assert.ok(Array.isArray(projection.runtime_workbench.archived_attempts));
    assert.equal(projection.runtime_workbench.memory_trace_projection.surface_kind, 'opl_memory_trace_projection');
    assert.equal(projection.runtime_workbench.workstream_operating_loop.surface_kind, 'opl_workstream_operating_loop_projection');
    assert.equal(
      projection.runtime_workbench.current_work_unit_first_read_model.surface_kind,
      'opl_app_current_work_unit_first_read_model',
    );
    assert.equal(
      projection.runtime_workbench.domain_current_work_unit_projection.surface_kind,
      'opl_domain_current_work_unit_projection',
    );
    assert.equal(projection.authority_boundary.can_write_domain_truth, false);
    assert.equal(projection.authority_boundary.can_read_memory_body, false);
    assert.equal(projection.authority_boundary.can_read_artifact_body, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
