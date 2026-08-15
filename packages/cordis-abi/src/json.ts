import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';

export type JsonSchemaRegistryEntry = {
  schemaId: string;
  schema: AnySchema;
  sourceRef?: string;
};

export type JsonSchemaValidationIssue = {
  instance_path: string;
  schema_path: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
};

export type JsonSchemaValidationResult =
  | { ok: true; schema_id: string; source_ref?: string }
  | { ok: false; schema_id: string; source_ref?: string; errors: JsonSchemaValidationIssue[] };

export class CordisAbiContractError extends Error {
  readonly code = 'contract_shape_invalid';
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'CordisAbiContractError';
    this.details = details;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const compiledValidators = new Map<string, ValidateFunction>();

function normalizeAjvErrors(errors: ErrorObject[] | null | undefined): JsonSchemaValidationIssue[] {
  return (errors ?? []).map((error) => ({
    instance_path: error.instancePath,
    schema_path: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? 'JSON Schema validation failed.',
    params: error.params as Record<string, unknown>,
  }));
}

function validator(entry: JsonSchemaRegistryEntry) {
  const cached = compiledValidators.get(entry.schemaId);
  if (cached) return cached;
  try {
    const compiled = ajv.compile(entry.schema);
    compiledValidators.set(entry.schemaId, compiled);
    return compiled;
  } catch (error) {
    throw new CordisAbiContractError('JSON Schema contract could not be compiled.', {
      schema_id: entry.schemaId,
      source_ref: entry.sourceRef,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function validateJsonSchemaPayload(
  entry: JsonSchemaRegistryEntry,
  payload: unknown,
): JsonSchemaValidationResult {
  const validate = validator(entry);
  if (validate(payload)) {
    return {
      ok: true,
      schema_id: entry.schemaId,
      ...(entry.sourceRef ? { source_ref: entry.sourceRef } : {}),
    };
  }
  return {
    ok: false,
    schema_id: entry.schemaId,
    ...(entry.sourceRef ? { source_ref: entry.sourceRef } : {}),
    errors: normalizeAjvErrors(validate.errors),
  };
}

export function assertJsonSchemaPayload(entry: JsonSchemaRegistryEntry, payload: unknown): void {
  const result = validateJsonSchemaPayload(entry, payload);
  if (result.ok) return;
  throw new CordisAbiContractError('Payload failed JSON Schema validation.', {
    schema_id: result.schema_id,
    source_ref: result.source_ref,
    errors: result.errors,
  });
}

function canonicalValue(value: unknown, path: string): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CordisAbiContractError('Canonical JSON does not allow non-finite numbers.', { path });
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.some((_, index) => !Object.hasOwn(value, index))) {
      throw new CordisAbiContractError('Canonical JSON does not allow sparse arrays.', { path });
    }
    return `[${value.map((entry, index) => canonicalValue(entry, `${path}/${index}`)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      const entry = record[key];
      if (entry === undefined || typeof entry === 'bigint' || typeof entry === 'function' || typeof entry === 'symbol') {
        throw new CordisAbiContractError('Canonical JSON contains an unsupported value.', {
          path: `${path}/${key}`,
          value_type: typeof entry,
        });
      }
      return `${JSON.stringify(key)}:${canonicalValue(entry, `${path}/${key}`)}`;
    }).join(',')}}`;
  }
  throw new CordisAbiContractError('Canonical JSON contains an unsupported value.', {
    path,
    value_type: typeof value,
  });
}

export function canonicalJsonBytes(value: unknown) {
  return Buffer.from(canonicalValue(value, '$'), 'utf8');
}
