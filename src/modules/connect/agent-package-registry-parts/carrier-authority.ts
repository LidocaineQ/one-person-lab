import { FrameworkContractError } from '../../../kernel/contract-validation.ts';

import type {
  AgentPackageCarrierAuthority,
  AgentPackageLock,
} from './types.ts';

const EXACT_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function buildAgentPackageCarrierAuthority(input: {
  packageId: string;
  catalogRef: string | null;
  catalogSha256: string | null;
  catalogOwnerSourceCommit: string | null;
  manifestCarrierSourceCommit: string | null;
  payloadSourceCommit: string | null;
}): AgentPackageCarrierAuthority {
  const failures = [
    input.catalogRef ? null : 'catalog_ref_missing',
    SHA256.test(input.catalogSha256 ?? '') ? null : 'catalog_sha256_invalid',
    EXACT_COMMIT.test(input.catalogOwnerSourceCommit ?? '') ? null : 'catalog_owner_source_commit_invalid',
    EXACT_COMMIT.test(input.manifestCarrierSourceCommit ?? '') ? null : 'manifest_carrier_source_commit_invalid',
    EXACT_COMMIT.test(input.payloadSourceCommit ?? '') ? null : 'payload_source_commit_invalid',
    input.catalogOwnerSourceCommit === input.manifestCarrierSourceCommit ? null : 'catalog_manifest_commit_mismatch',
    input.manifestCarrierSourceCommit === input.payloadSourceCommit ? null : 'manifest_payload_commit_mismatch',
  ].filter((failure): failure is string => failure !== null);
  if (failures.length > 0) {
    throw new FrameworkContractError('contract_shape_invalid', 'Package carrier authority is incomplete or inconsistent.', {
      package_id: input.packageId,
      catalog_ref: input.catalogRef,
      catalog_sha256: input.catalogSha256,
      catalog_owner_source_commit: input.catalogOwnerSourceCommit,
      manifest_carrier_source_commit: input.manifestCarrierSourceCommit,
      payload_source_commit: input.payloadSourceCommit,
      failures,
      failure_code: 'agent_package_carrier_authority_invalid',
    });
  }
  return {
    surface_kind: 'opl_agent_package_carrier_authority.v1',
    status: 'verified',
    catalog_ref: input.catalogRef!,
    catalog_sha256: input.catalogSha256!,
    catalog_owner_source_commit: input.catalogOwnerSourceCommit!,
    manifest_carrier_source_commit: input.manifestCarrierSourceCommit!,
    payload_source_commit: input.payloadSourceCommit!,
    verified_source_commit: input.payloadSourceCommit!,
  };
}

export function agentPackageCarrierAuthorityStatus(lock: AgentPackageLock) {
  const required = lock.source_kind === 'first_party_managed_cohort'
    || lock.source_kind === 'bundled_full_runtime_modules';
  const authority = lock.carrier_authority ?? null;
  if (!required && !authority) {
    return { status: 'not_required' as const, reasons: [] as string[] };
  }
  const reasons = [
    authority ? null : 'carrier_authority_missing',
    authority?.surface_kind === 'opl_agent_package_carrier_authority.v1' ? null : 'carrier_authority_surface_invalid',
    authority?.status === 'verified' ? null : 'carrier_authority_status_invalid',
    authority?.catalog_ref ? null : 'catalog_ref_missing',
    SHA256.test(authority?.catalog_sha256 ?? '') ? null : 'catalog_sha256_invalid',
    EXACT_COMMIT.test(lock.owner_source_commit ?? '') ? null : 'owner_source_commit_invalid',
    authority?.catalog_owner_source_commit === lock.owner_source_commit ? null : 'catalog_owner_source_commit_mismatch',
    authority?.manifest_carrier_source_commit === lock.owner_source_commit ? null : 'manifest_carrier_source_commit_mismatch',
    authority?.payload_source_commit === lock.owner_source_commit ? null : 'payload_source_commit_mismatch',
    authority?.verified_source_commit === lock.owner_source_commit ? null : 'verified_source_commit_mismatch',
    authority?.catalog_ref === lock.release_channel_ref ? null : 'catalog_ref_lock_mismatch',
    authority?.catalog_sha256 === lock.release_channel_digest ? null : 'catalog_sha256_lock_mismatch',
    lock.source_kind !== 'bundled_full_runtime_modules'
      || !lock.runtime_source_carrier
      || lock.managed_runtime_source?.source_mode === 'bundled_full_runtime'
      ? null
      : 'bundled_runtime_source_mode_mismatch',
  ].filter((reason): reason is string => reason !== null);
  return {
    status: reasons.length === 0 ? 'current' as const : 'invalid' as const,
    reasons,
  };
}
