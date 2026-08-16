import {
  FrameworkContractError,
  expectBoolean,
  expectString,
  expectStringArray,
  isRecord,
} from '../../../kernel/contract-validation.ts';

export const APP_TYPED_DOMAIN_VIEWS_V3_CAPABILITY_ID = 'opl_app.typed_domain_views.v3';

function fail(filePath: string, field: string, message: string): never {
  throw new FrameworkContractError('contract_shape_invalid', message, { file: filePath, field });
}

function record(value: unknown, field: string, filePath: string) {
  if (!isRecord(value)) fail(filePath, field, `${field} must be an object.`);
  return value;
}

function records(value: unknown, field: string, filePath: string) {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    fail(filePath, field, `${field} must be an array of objects.`);
  }
  return value;
}

function requireBoolean(
  value: unknown,
  expected: boolean,
  field: string,
  filePath: string,
) {
  const actual = expectBoolean(value, field, filePath);
  if (actual !== expected) fail(filePath, field, `${field} must be ${expected}.`);
}

function requireTypedViewSchema(
  schema: unknown,
  path: readonly string[],
  filePath: string,
) {
  let current = record(schema, 'schema', filePath);
  for (const segment of path) current = record(current[segment], path.join('.'), filePath);
  const properties = record(current.properties, `${path.join('.')}.properties`, filePath);
  for (const field of ['view_kind', 'schema_ref', 'schema_version']) {
    const property = record(properties[field], `${path.join('.')}.properties.${field}`, filePath);
    if (expectString(property.type, `${field}.type`, filePath) !== 'string') {
      fail(filePath, `${field}.type`, `${field} must remain a string field.`);
    }
  }
}

export function validateAppRuntimeFastWorkItemProjectionContract(input: {
  filePath: string;
  value: unknown;
  standardAgentInterfaceSchema: unknown;
  workItemProjectionSchema: unknown;
  publicAppCommandIds: readonly string[];
}) {
  const root = record(input.value, 'root', input.filePath);
  if (
    expectString(root.contract_kind, 'contract_kind', input.filePath)
    !== 'opl_app_runtime_fast_work_item_projection_producer.v1'
  ) {
    fail(input.filePath, 'contract_kind', 'Unexpected fast Work Item producer contract kind.');
  }
  if (expectString(root.owner, 'owner', input.filePath) !== 'one-person-lab') {
    fail(input.filePath, 'owner', 'Framework must own this producer contract.');
  }

  const producerSurface = expectString(root.producer_surface, 'producer_surface', input.filePath);
  if (!producerSurface.startsWith('opl app state --profile fast --json')) {
    fail(input.filePath, 'producer_surface', 'Fast Work Item projection must be produced by the fast App state surface.');
  }
  if (
    expectString(root.projection_schema_ref, 'projection_schema_ref', input.filePath)
    !== 'contracts/opl-framework/work-item-projection-v2.schema.json'
  ) {
    fail(input.filePath, 'projection_schema_ref', 'Fast Work Item projection must use the canonical projection schema.');
  }

  const inventory = record(root.inventory_policy, 'inventory_policy', input.filePath);
  requireBoolean(
    inventory.all_registered_work_item_summaries_included,
    true,
    'inventory_policy.all_registered_work_item_summaries_included',
    input.filePath,
  );
  requireBoolean(
    inventory.runtime_history_may_create_work_items,
    false,
    'inventory_policy.runtime_history_may_create_work_items',
    input.filePath,
  );

  const boundedFast = record(root.bounded_fast_policy, 'bounded_fast_policy', input.filePath);
  const attemptRefLimit = boundedFast.attempt_ref_limit_per_item;
  if (typeof attemptRefLimit !== 'number' || !Number.isInteger(attemptRefLimit) || attemptRefLimit < 0) {
    fail(input.filePath, 'bounded_fast_policy.attempt_ref_limit_per_item', 'Attempt ref limit must be a non-negative integer.');
  }
  if (expectString(boundedFast.inventory_detail, 'bounded_fast_policy.inventory_detail', input.filePath) !== 'included') {
    fail(input.filePath, 'bounded_fast_policy.inventory_detail', 'Fast inventory summaries must remain included.');
  }
  requireBoolean(
    boundedFast.diagnostic_items_embedded,
    false,
    'bounded_fast_policy.diagnostic_items_embedded',
    input.filePath,
  );

  const authority = record(root.authority_boundary, 'authority_boundary', input.filePath);
  requireBoolean(authority.projection_only, true, 'authority_boundary.projection_only', input.filePath);
  for (const field of [
    'can_write_domain_truth',
    'can_create_owner_receipt',
    'can_create_typed_blocker',
    'can_authorize_quality_verdict',
    'can_authorize_publication_or_submission',
  ]) {
    requireBoolean(authority[field], false, `authority_boundary.${field}`, input.filePath);
  }

  const capabilities = record(root.compatibility_capabilities, 'compatibility_capabilities', input.filePath);
  const ids = expectStringArray(capabilities.ids, 'compatibility_capabilities.ids', input.filePath);
  if (new Set(ids).size !== ids.length || !ids.includes(APP_TYPED_DOMAIN_VIEWS_V3_CAPABILITY_ID)) {
    fail(input.filePath, 'compatibility_capabilities.ids', 'Compatibility capability ids must be unique and include typed domain views v3.');
  }
  const definitions = records(
    capabilities.definitions,
    'compatibility_capabilities.definitions',
    input.filePath,
  );
  const definition = definitions.find(
    (entry) => entry.capability_id === APP_TYPED_DOMAIN_VIEWS_V3_CAPABILITY_ID,
  );
  if (!definition) {
    fail(input.filePath, 'compatibility_capabilities.definitions', 'Typed domain views v3 requires a matching definition.');
  }
  if (expectString(definition.state_surface, 'state_surface', input.filePath) !== producerSurface) {
    fail(input.filePath, 'state_surface', 'Capability state surface must match the producer surface.');
  }
  if (expectString(definition.state_field, 'state_field', input.filePath) !== 'items[].domain_detail_views') {
    fail(input.filePath, 'state_field', 'Typed views must project on Work Item summaries.');
  }
  for (const field of ['descriptor_contract_ref', 'projection_contract_ref']) {
    expectString(definition[field], field, input.filePath);
  }
  if (!Array.isArray(definition.missing_descriptor_projection)) {
    fail(input.filePath, 'missing_descriptor_projection', 'Missing typed view declarations must have an array projection.');
  }
  expectString(definition.lazy_read_command, 'lazy_read_command', input.filePath);
  if (!input.publicAppCommandIds.includes('app view read')) {
    fail(input.filePath, 'lazy_read_command', 'The typed view lazy-read command must exist in the public App command surface.');
  }

  requireTypedViewSchema(
    input.standardAgentInterfaceSchema,
    ['properties', 'domain_detail_views', 'items'],
    input.filePath,
  );
  requireTypedViewSchema(
    input.workItemProjectionSchema,
    ['$defs', 'domainDetailView'],
    input.filePath,
  );
  return root;
}
