import assert from 'node:assert/strict';
import test from 'node:test';

import { Context } from '@deepseek-ai/cordis';

import {
  buildCordisPackStagecraftCompositionSnapshot,
  createCordisStageRouteComposition,
} from '../../src/host/plugins/cordis-agent-executor-experiment.ts';
import {
  CORDIS_PACK_STAGE_BINDING_SERVICE,
} from '../../src/host/plugins/cordis-pack-stage-binding-plugin.ts';
import {
  CORDIS_STAGECRAFT_CONTEXT_SERVICE,
  cordisStagecraftContextPlugin,
} from '../../src/host/plugins/cordis-stagecraft-context-plugin.ts';

test('Pack and Stagecraft services compose with deterministic snapshot and disposal', async () => {
  const composition = await createCordisStageRouteComposition();
  try {
    assert.ok(composition.ctx.get(CORDIS_STAGECRAFT_CONTEXT_SERVICE));
    assert.ok(composition.ctx.get(CORDIS_PACK_STAGE_BINDING_SERVICE));
    assert.deepEqual(composition.snapshot, buildCordisPackStagecraftCompositionSnapshot());
    assert.match(composition.snapshot.snapshot_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(composition.snapshot.plugins.length, 2);
  } finally {
    await composition.dispose();
  }
  assert.equal(composition.ctx.get(CORDIS_STAGECRAFT_CONTEXT_SERVICE), undefined);
  assert.equal(composition.ctx.get(CORDIS_PACK_STAGE_BINDING_SERVICE), undefined);
});

test('optional Atlas catalog does not block Stagecraft context composition', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(cordisStagecraftContextPlugin);
  try {
    const service = ctx.get(CORDIS_STAGECRAFT_CONTEXT_SERVICE);
    assert.ok(service);
    const observation = service.observe({} as never, {
      domainId: 'missing-domain',
      stageId: 'review',
    });
    assert.equal(observation.status, 'declaration_debt');
    assert.equal(observation.progression_effect, 'stage_may_start');
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
