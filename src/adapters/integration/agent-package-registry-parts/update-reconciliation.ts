import path from 'node:path';

import { FrameworkContractError } from '../../../kernel/contract-validation.ts';
import { stringValue } from '../../../kernel/json-record.ts';
import {
  assertFirstPartyPackageCatalogVersion,
  resolveFirstPartyPackageCatalog,
} from '../agent-package-first-party.ts';
import type { ManagedPackageCatalog } from './capability-reconciliation.ts';
import { resolveAgentPackageEffectiveSourcePolicy } from './source-policy.ts';
import type { AgentPackageInstallInput } from './types.ts';

export function assertFirstPartyPackageUpdateSelection(
  input: AgentPackageInstallInput,
  firstParty: NonNullable<ReturnType<typeof resolveFirstPartyPackageCatalog>>,
  sourcePolicy: ReturnType<typeof resolveAgentPackageEffectiveSourcePolicy>,
) {
  const manifestUrl = stringValue(input.manifestUrl);
  const registryUrl = stringValue(input.registryUrl);
  if (manifestUrl || registryUrl) {
    throw new FrameworkContractError('contract_shape_invalid', 'Canonical first-party packages resolve through their per-Package owner OCI latest-stable channel; explicit manifest or registry selection is not allowed.', {
      package_id: firstParty.canonicalId,
      explicit_manifest_source: Boolean(manifestUrl),
      explicit_registry_source: Boolean(registryUrl),
      failure_code: 'first_party_package_explicit_source_forbidden',
    });
  }
  const requestedTrustTier = stringValue(input.trustTier);
  if (requestedTrustTier && requestedTrustTier !== firstParty.trustTier) {
    throw new FrameworkContractError('contract_shape_invalid', 'First-party catalog packages use the fixed first_party trust tier.', {
      package_id: firstParty.canonicalId,
      requested_trust_tier: requestedTrustTier,
      required_trust_tier: firstParty.trustTier,
      failure_code: 'first_party_package_trust_tier_override_forbidden',
    });
  }
  if (!sourcePolicy.desired_source_kind) {
    throw new FrameworkContractError('contract_shape_invalid', 'First-party Package update requires an effective managed or developer source policy.', {
      package_id: firstParty.canonicalId,
      source_policy_reason: sourcePolicy.reason,
      failure_code: 'first_party_package_source_policy_unresolved',
    });
  }
  if (input.sourceKind && input.sourceKind !== sourcePolicy.desired_source_kind) {
    throw new FrameworkContractError('contract_shape_invalid', 'First-party Package source kind must match the effective module source policy.', {
      package_id: firstParty.canonicalId,
      requested_source_kind: input.sourceKind,
      required_source_kind: sourcePolicy.desired_source_kind,
      source_policy_reason: sourcePolicy.reason,
      failure_code: 'first_party_package_source_kind_policy_mismatch',
    });
  }
  if (sourcePolicy.desired_source_kind !== 'developer_checkout_override') return;
  if (!sourcePolicy.developer_checkout_available || !sourcePolicy.developer_checkout_path) {
    throw new FrameworkContractError('contract_shape_invalid', 'Developer Mode selected a package checkout that is not available.', {
      package_id: firstParty.canonicalId,
      module_id: sourcePolicy.module_id,
      checkout_path: sourcePolicy.developer_checkout_path,
      source_policy_reason: sourcePolicy.reason,
      failure_code: 'agent_package_developer_checkout_unavailable',
    });
  }
  const requestedCheckoutPath = stringValue(input.agentRoot);
  if (requestedCheckoutPath
    && path.resolve(requestedCheckoutPath) !== path.resolve(sourcePolicy.developer_checkout_path)) {
    throw new FrameworkContractError('contract_shape_invalid', 'First-party Package developer checkout must match the effective module source policy.', {
      package_id: firstParty.canonicalId,
      requested_checkout_path: path.resolve(requestedCheckoutPath),
      required_checkout_path: path.resolve(sourcePolicy.developer_checkout_path),
      source_policy_reason: sourcePolicy.reason,
      failure_code: 'first_party_package_developer_checkout_path_mismatch',
    });
  }
}

export function ownerPackageCatalogVersion(
  catalog: ManagedPackageCatalog,
  packageId: string,
) {
  const versions = catalog.get(packageId)?.versions ?? [];
  if (versions.length !== 1) {
    throw new FrameworkContractError('contract_shape_invalid', 'Package owner latest-stable must resolve to one Package identity.', {
      package_id: packageId,
      candidate_count: versions.length,
      failure_code: 'agent_package_owner_channel_identity_invalid',
    });
  }
  return versions[0];
}
