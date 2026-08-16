import {
  CANONICAL_OPL_PACKAGE_IDS,
  canonicalAgentPackageId,
} from './agent-package-identity.ts';

const FIRST_PARTY_PACKAGE_IDS = new Set<string>(CANONICAL_OPL_PACKAGE_IDS);
const DEFAULT_FIRST_PARTY_PACKAGE_OWNER = 'gaofeng21cn';

export function isFirstPartyPackage(packageId: string | null | undefined) {
  const canonicalId = canonicalAgentPackageId(packageId);
  return canonicalId !== null && FIRST_PARTY_PACKAGE_IDS.has(canonicalId);
}

export function resolveFirstPartyPackageOwnerChannelRef(packageId: string | null | undefined) {
  const canonicalId = canonicalAgentPackageId(packageId);
  if (!canonicalId || !isFirstPartyPackage(canonicalId)) return null;
  const configuredOwner = process.env.OPL_PACKAGES_OWNER?.trim();
  const owner = configuredOwner || DEFAULT_FIRST_PARTY_PACKAGE_OWNER;
  return `ghcr.io/${owner}/one-person-lab-packages/${canonicalId}:latest-stable`;
}
