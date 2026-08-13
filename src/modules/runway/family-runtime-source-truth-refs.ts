import crypto from 'node:crypto';

import { canonicalJsonBytes } from '../../kernel/canonical-json.ts';
import { FrameworkContractError, isRecord } from '../../kernel/contract-validation.ts';

export type PrevalidatedSourceTruthRefs = {
  manifest_ref: string;
  readiness_ref: string;
  source_package_digest_ref: string;
};

const SOURCE_TRUTH_REF_FIELDS = [
  'manifest_ref',
  'readiness_ref',
  'source_package_digest_ref',
] as const;

export function readPrevalidatedSourceTruthRefs(
  value: unknown,
  field = 'source_truth_refs',
): PrevalidatedSourceTruthRefs | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Prevalidated source truth refs must be a refs-only object.',
      { failure_code: 'source_truth_refs_shape_invalid', field },
    );
  }
  const receivedFields = Object.keys(value).sort();
  const expectedFields = [...SOURCE_TRUTH_REF_FIELDS].sort();
  if (JSON.stringify(receivedFields) !== JSON.stringify(expectedFields)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Prevalidated source truth refs must use the exact declared fields.',
      {
        failure_code: 'source_truth_refs_shape_invalid',
        field,
        expected_fields: expectedFields,
        received_fields: receivedFields,
      },
    );
  }
  const refs = Object.fromEntries(SOURCE_TRUTH_REF_FIELDS.map((refField) => {
    const ref = value[refField];
    if (typeof ref !== 'string' || !ref.trim() || ref !== ref.trim()) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Prevalidated source truth refs must be non-empty canonical strings.',
        {
          failure_code: 'source_truth_ref_invalid',
          field: `${field}.${refField}`,
        },
      );
    }
    return [refField, ref];
  })) as PrevalidatedSourceTruthRefs;
  return refs;
}

export function prevalidatedSourceTruthFingerprint(refs: PrevalidatedSourceTruthRefs) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJsonBytes(refs)).digest('hex')}`;
}

export function requirePrevalidatedSourceTruthFingerprint(
  refs: PrevalidatedSourceTruthRefs,
  value: unknown,
  field = 'source_fingerprint',
) {
  const expected = prevalidatedSourceTruthFingerprint(refs);
  const match = typeof value === 'string'
    ? value.trim().match(/^(?:sha256:)?([a-f0-9]{64})$/i)
    : null;
  const received = match ? `sha256:${match[1]!.toLowerCase()}` : null;
  if (received !== expected) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Prevalidated source truth refs require their exact canonical source fingerprint.',
      {
        failure_code: 'source_truth_refs_fingerprint_mismatch',
        field,
        expected_source_fingerprint: expected,
        received_source_fingerprint: received,
      },
    );
  }
  return expected;
}
