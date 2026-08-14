import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CORDIS_WORKSPACE_LOCATOR_SERVICE,
  createCordisWorkspaceLocatorComposition,
} from '../../src/modules/workspace/cordis-workspace-locator.ts';
import {
  CORDIS_OWNER_DELTA_OBSERVER_SERVICE,
  createCordisOwnerDeltaObserverComposition,
} from '../../src/modules/ledger/cordis-owner-delta-observer.ts';
import { buildCurrentOwnerDeltaTopline as buildDirectTopline } from '../../src/modules/ledger/current-owner-delta-topline.ts';
import { buildCurrentOwnerDeltaTopline as buildCordisTopline } from '../../src/modules/ledger/index.ts';
import { resolveWorkspaceLocator as resolveCordisWorkspaceLocator } from '../../src/modules/workspace/index.ts';

test('Cordis Workspace locator delegates to the registry and tears down cleanly', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-cordis-workspace-'));
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = stateRoot;
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  const composition = await createCordisWorkspaceLocatorComposition();
  const events: unknown[] = [];
  composition.ctx.on('opl/workspace/locator/resolved', (locator) => events.push(locator));

  const locator = composition.locator.resolve('missing-project');
  assert.equal(locator.project_id, 'missing-project');
  assert.equal(locator.binding, null);
  assert.equal(locator.source, 'none');
  assert.deepEqual(events, [locator]);
  assert.equal(composition.ctx[CORDIS_WORKSPACE_LOCATOR_SERVICE], composition.locator);
  assert.deepEqual(resolveCordisWorkspaceLocator('missing-project'), locator);
  assert.deepEqual(fs.readdirSync(stateRoot), []);

  await composition.dispose();
  assert.equal(composition.fiber.uid, null);
  assert.equal(composition.ctx.get(CORDIS_WORKSPACE_LOCATOR_SERVICE), undefined);
});

test('Cordis Ledger observer emits a refs-only projection without persistence', async () => {
  const composition = await createCordisOwnerDeltaObserverComposition();
  const observations: unknown[] = [];
  composition.ctx.on('opl/ledger/owner-delta/observed', (topline) => observations.push(topline));

  const input = {
    currentOwnerDeltaReadModel: {
      current_owner_delta: {
        current_owner: 'one-person-lab',
        desired_delta_description: 'inspect_refs',
        accepted_answer_shape: ['owner_receipt_ref'],
      },
      next_safe_action_or_none: null,
    },
  };
  const observed = composition.observer.observe(input);
  assert.deepEqual(observed, buildDirectTopline(input));
  assert.deepEqual(observations, [observed]);
  assert.equal(observed.stage_run_cockpit_summary.refs_only, true);
  assert.equal(observed.stage_run_cockpit_summary.semantic_route_owner, 'decisive_codex_attempt');
  assert.equal(composition.ctx[CORDIS_OWNER_DELTA_OBSERVER_SERVICE], composition.observer);

  await composition.dispose();
  assert.equal(composition.fiber.uid, null);
  assert.equal(composition.ctx.get(CORDIS_OWNER_DELTA_OBSERVER_SERVICE), undefined);
});

test('Ledger public topline caller uses the Cordis observer composition', () => {
  const input = {
    currentOwnerDeltaReadModel: {
      current_owner_delta: {
        current_owner: 'one-person-lab',
        desired_delta_description: 'public_index_route',
      },
    },
  };
  assert.deepEqual(buildCordisTopline(input), buildDirectTopline(input));
});
