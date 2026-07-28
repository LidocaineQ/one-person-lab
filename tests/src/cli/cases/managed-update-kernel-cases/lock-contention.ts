import {
  assert,
  fs,
  os,
  path,
  runCliFailure,
  test,
} from '../../helpers.ts';
import { acquireManagedUpdateLock } from '../../../../../src/modules/connect/managed-update-lock.ts';

test('packages update reports lock contention without running a parallel writer', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-managed-update-lock-'));
  const stateRoot = path.join(homeRoot, 'state');
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, 'managed-update-kernel.lock'),
    JSON.stringify({
      lock_id: 'opl_managed_updater_kernel.global',
      acquired_at: new Date().toISOString(),
      operation: 'apply',
      // Keep the owner alive so this fixture exercises genuine contention.
      pid: process.pid,
    }),
    'utf8',
  );

  try {
    const failure = runCliFailure(['packages', 'update'], {
      HOME: homeRoot,
      CODEX_HOME: path.join(homeRoot, 'codex-home'),
      OPL_STATE_DIR: stateRoot,
      OPL_MODULES_ROOT: path.join(homeRoot, 'modules'),
    }) as {
      status: number;
      payload: {
        error: {
          code: string;
          message: string;
          details: {
            surface_id: string;
            lock_status: string;
            repair_action: string;
          };
        };
      };
    };

    assert.equal(failure.status, 3);
    assert.equal(failure.payload.error.code, 'managed_update_lock_contention');
    assert.equal(failure.payload.error.details.surface_id, 'opl_managed_updater_kernel');
    assert.equal(failure.payload.error.details.lock_status, 'held');
    assert.equal(failure.payload.error.details.repair_action, 'retry_after_current_update_finishes_or_remove_stale_lock_after_timeout');
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('managed update reclaims a recent lock whose owner process is gone', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-managed-update-orphan-lock-'));
  const stateRoot = path.join(homeRoot, 'state');
  fs.mkdirSync(stateRoot, { recursive: true });
  const lockFile = path.join(stateRoot, 'managed-update-kernel.lock');
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      lock_id: 'opl_managed_updater_kernel.global',
      acquired_at: new Date().toISOString(),
      operation: 'apply',
      pid: 999999,
    }),
    'utf8',
  );

  const previousStateDir = process.env.OPL_STATE_DIR;
  const previousHome = process.env.HOME;
  process.env.OPL_STATE_DIR = stateRoot;
  process.env.HOME = homeRoot;
  try {
    const lock = acquireManagedUpdateLock({ operation: 'apply' });
    assert.equal(lock.status, 'acquired');
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid);
    lock.release();
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});
