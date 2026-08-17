import {
  CANONICAL_OPL_PACKAGE_IDS,
  canonicalAgentPackageId,
} from './agent-package-identity.ts';

const FIRST_PARTY_PACKAGE_IDS = new Set<string>(CANONICAL_OPL_PACKAGE_IDS);

export function isFirstPartyPackage(packageId: string | null | undefined) {
  const canonicalId = canonicalAgentPackageId(packageId);
  return canonicalId !== null && FIRST_PARTY_PACKAGE_IDS.has(canonicalId);
}
