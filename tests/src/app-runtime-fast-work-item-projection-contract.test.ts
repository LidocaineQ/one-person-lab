import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { parseJsonText } from '../../src/kernel/json-file.ts';
import { buildPublicAppCommandSpecs } from '../../src/entrypoints/cli/cases/app-public-command-specs.ts';
import { buildAppRuntimeWorkItemProjection } from '../../src/read-models/operator/app-runtime-work-item-projection.ts';
import {
  APP_TYPED_DOMAIN_VIEWS_V3_CAPABILITY_ID,
  validateAppRuntimeFastWorkItemProjectionContract,
} from '../../src/authority/contracts/contract-validators/app-runtime-fast-work-item-projection-contract.ts';

const CONTRACT_REF = 'contracts/opl-framework/app-runtime-fast-work-item-projection-contract.json';

function readJson(ref: string) {
  return parseJsonText(fs.readFileSync(ref, 'utf8')) as Record<string, any>;
}

function validate(value: unknown) {
  return validateAppRuntimeFastWorkItemProjectionContract({
    filePath: CONTRACT_REF,
    value,
    standardAgentInterfaceSchema: readJson('contracts/opl-framework/standard-agent-interface.schema.json'),
    workItemProjectionSchema: readJson('contracts/opl-framework/work-item-projection-v2.schema.json'),
    publicAppCommandIds: Object.keys(buildPublicAppCommandSpecs(() => {
      throw new Error('Contract loading is not needed to enumerate App commands.');
    })),
  });
}

test('fast Work Item producer contract validates its structural ABI', () => {
  const contract = readJson(CONTRACT_REF);
  assert.equal(validate(contract), contract);

  const publicSurfaceIndex = readJson('contracts/opl-framework/public-surface-index.json');
  const workbench = publicSurfaceIndex.surfaces.find(
    (entry: Record<string, unknown>) => entry.surface_id === 'one_person_lab_app_workbench',
  );
  assert.equal(
    workbench.refs.some(
      (entry: Record<string, unknown>) => typeof entry.ref === 'string'
        && entry.ref.startsWith(`${CONTRACT_REF}#`),
    ),
    true,
  );
});

test('fast Work Item producer includes bounded inventory even when empty', () => {
  const projection = buildAppRuntimeWorkItemProjection({
    profile: 'fast',
    bindings: [],
    attempts: [],
    generatedAt: '2026-07-15T00:00:00.000Z',
  });

  assert.deepEqual(projection.items, []);
  assert.equal(projection.detail_policy.inventory_detail, 'included');
  assert.equal(projection.detail_policy.all_work_item_summaries_included, true);
  assert.equal(projection.diagnostics.detail_policy, 'summary_only');
  assert.deepEqual(projection.diagnostics.items, []);
});

test('fast Work Item producer contract rejects a capability without a definition', () => {
  const contract = structuredClone(readJson(CONTRACT_REF));
  contract.compatibility_capabilities.ids = [APP_TYPED_DOMAIN_VIEWS_V3_CAPABILITY_ID];
  contract.compatibility_capabilities.definitions = [];

  assert.throws(() => validate(contract), /requires a matching definition/);
});
