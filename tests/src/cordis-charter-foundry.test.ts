import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Context } from '@deepseek-ai/cordis';

import {
  CORDIS_CHARTER_CONTRACTS_SERVICE,
  CORDIS_CHARTER_POLICY_PLUGIN_DESCRIPTOR,
  cordisCharterPolicyPlugin,
} from '../../src/modules/charter/index.ts';
import {
  CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_DESCRIPTOR,
  CORDIS_FOUNDRY_EVALUATION_SERVICE,
  CORDIS_FOUNDRY_PLUGIN_DESCRIPTORS,
  CORDIS_FOUNDRY_PROVIDER_MANIFEST_PLUGIN_DESCRIPTOR,
  CORDIS_FOUNDRY_PROVIDER_MANIFEST_SERVICE,
  cordisFoundryEvaluationAdapterPlugin,
  cordisFoundryProviderManifestPlugin,
  type EvaluationExecutor,
} from '../../src/modules/foundry/index.ts';
import {
  assertCordisPluginDescriptor,
  validateCordisPluginDescriptor,
} from '../../src/modules/pack/index.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const providerManifestRef = 'tests/fixtures/oma-0.4.0/foundry_provider.json';

test('Charter and Foundry publish P4-compatible plugin descriptors without taking authority', () => {
  const descriptors = [
    CORDIS_CHARTER_POLICY_PLUGIN_DESCRIPTOR,
    ...CORDIS_FOUNDRY_PLUGIN_DESCRIPTORS,
  ];
  for (const descriptor of descriptors) {
    assertCordisPluginDescriptor(descriptor);
    assert.equal(validateCordisPluginDescriptor(descriptor).ok, true);
    assert.equal(descriptor.package_ref, null);
  }
  assert.equal(CORDIS_CHARTER_POLICY_PLUGIN_DESCRIPTOR.required, true);
  assert.equal(CORDIS_FOUNDRY_PROVIDER_MANIFEST_PLUGIN_DESCRIPTOR.required, true);
  assert.equal(CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_DESCRIPTOR.scope, 'attempt');
  assert.equal(
    CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_DESCRIPTOR
      .authority_boundary.forbidden_authorities.includes('foundry_agent_version'),
    true,
  );
  assert.equal(
    CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_DESCRIPTOR
      .authority_boundary.forbidden_authorities.includes('foundry_promotion_activation'),
    true,
  );
});

test('Cordis Charter service delegates every load to the Charter contract owner', async () => {
  const ctx = new Context();
  const observed: string[] = [];
  const observerFiber = await ctx.plugin({
    name: 'charter-policy-test-observer',
    apply(observerContext: Context) {
      observerContext.on('opl/charter/contracts/loaded', (contracts) => {
        observed.push(contracts.contractsDir);
      });
    },
  });
  const policyFiber = await ctx.plugin(cordisCharterPolicyPlugin);
  try {
    const service = ctx.get(CORDIS_CHARTER_CONTRACTS_SERVICE);
    assert.ok(service);
    const first = service.load(repoRoot);
    const second = service.load(repoRoot);
    assert.notStrictEqual(first, second);
    assert.equal(first.contractsRootSource, 'api');
    assert.deepEqual(observed, [first.contractsDir, second.contractsDir]);
  } finally {
    await policyFiber.dispose();
    assert.equal(ctx.get(CORDIS_CHARTER_CONTRACTS_SERVICE), undefined);
    await observerFiber.dispose();
    await ctx.fiber.dispose();
  }
});

test('Cordis Foundry manifest service delegates normalization and contained reads', async () => {
  const ctx = new Context();
  const fiber = await ctx.plugin(cordisFoundryProviderManifestPlugin);
  try {
    const service = ctx.get(CORDIS_FOUNDRY_PROVIDER_MANIFEST_SERVICE);
    assert.ok(service);
    const parsed = JSON.parse(fs.readFileSync(
      path.join(repoRoot, providerManifestRef),
      'utf8',
    ));
    const normalized = service.normalize(parsed, providerManifestRef);
    const read = service.read(repoRoot, providerManifestRef);
    assert.deepEqual(read, normalized);
    assert.equal(read.provider_id, 'oma');
    assert.equal(read.authority_boundary.provider_owns_versions_or_activation, false);
  } finally {
    await fiber.dispose();
    assert.equal(ctx.get(CORDIS_FOUNDRY_PROVIDER_MANIFEST_SERVICE), undefined);
    await ctx.fiber.dispose();
  }
});

test('Cordis Foundry evaluation service preserves the injected owner executor ABI', async () => {
  type EvaluateInput = Parameters<EvaluationExecutor['evaluate']>[0];
  type CanaryInput = Parameters<EvaluationExecutor['canary']>[0];
  type Evidence = Awaited<ReturnType<EvaluationExecutor['evaluate']>>;

  const evaluateInput = { run_id: 'run:cordis-evaluate' } as EvaluateInput;
  const canaryInput = { run_id: 'run:cordis-canary' } as CanaryInput;
  const evaluateEvidence = { evidence_id: 'evidence:evaluate' } as Evidence;
  const canaryEvidence = { evidence_id: 'evidence:canary' } as Evidence;
  const calls: Array<'evaluate' | 'canary'> = [];
  const evaluator: EvaluationExecutor = {
    evaluator_id: 'fixture-foundry-owner-evaluator',
    qualification_capability: {
      status: 'observation_only',
      execution_mode: 'offline_projected_pack_observation.v1',
      protected_fact_authority: 'untrusted_process_observation',
    },
    async evaluate(input) {
      calls.push('evaluate');
      assert.strictEqual(input, evaluateInput);
      return evaluateEvidence;
    },
    async canary(input) {
      calls.push('canary');
      assert.strictEqual(input, canaryInput);
      return canaryEvidence;
    },
  };

  const ctx = new Context();
  const fiber = await ctx.plugin(cordisFoundryEvaluationAdapterPlugin, { evaluator });
  try {
    const service = ctx.get(CORDIS_FOUNDRY_EVALUATION_SERVICE);
    assert.ok(service);
    assert.equal(service.evaluator_id, evaluator.evaluator_id);
    assert.strictEqual(service.qualification_capability, evaluator.qualification_capability);
    assert.strictEqual(await service.evaluate(evaluateInput), evaluateEvidence);
    assert.strictEqual(await service.canary(canaryInput), canaryEvidence);
    assert.deepEqual(calls, ['evaluate', 'canary']);
    assert.equal(Object.hasOwn(service, 'activate'), false);
    assert.equal(Object.hasOwn(service, 'promote'), false);
  } finally {
    await fiber.dispose();
    assert.equal(ctx.get(CORDIS_FOUNDRY_EVALUATION_SERVICE), undefined);
    await ctx.fiber.dispose();
  }
});
