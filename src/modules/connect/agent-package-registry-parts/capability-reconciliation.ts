import crypto from 'node:crypto';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import { recordList, stringValue } from '../../../kernel/json-record.ts';
import { publicAgentPackageSelector } from '../agent-package-identity.ts';

export type ManagedCatalogVersion = {
  package_version: string;
  manifest_url: string;
  manifest_sha256: string;
  manifest_json: string | null;
  payload_manifest_json: string | null;
  payload_manifest_sha256: string | null;
  content_digest: string | null;
  payload_digest: string | null;
  source_artifact_ref: string | null;
  artifact_digest: string | null;
  artifact_status: string | null;
  package_content_digest: string | null;
  owner_source_commit: string | null;
  dependency_package_ids: string[];
  selection_status: 'selected_for_release_set' | 'retained_history';
};

type ManagedCatalogEntry = {
  package_id: string;
  package_role: 'standard_agent' | 'capability_package' | 'workflow_profile';
  selected_version: string;
  versions: ManagedCatalogVersion[];
};

export type ManagedPackageCatalog = Map<string, ManagedCatalogEntry>;

function sha256(value: string) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function normalizedSha256(value: unknown) {
  const digest = stringValue(value);
  if (!digest) return null;
  return digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
}

function releaseSetPackageCatalog(payload: unknown) {
  if (!isRecord(payload)) return null;
  if (payload.surface_kind === 'opl_package_repository_index.v1') {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      "The Framework Package repository compatibility index is retired; use each Package owner's OCI latest-stable channel.",
      { failure_code: 'agent_package_repository_index_retired' },
    );
  }
  if (payload.surface_kind !== undefined && payload.surface_kind !== 'opl_package_catalog.v1') {
    return null;
  }
  if (!isRecord(payload.packages)) return null;
  return isRecord(payload.packages.package_catalog)
    ? payload.packages.package_catalog
    : payload.packages;
}

function normalizeCatalogVersion(value: unknown): ManagedCatalogVersion | null {
  if (!isRecord(value)) return null;
  const packageVersion = stringValue(value.package_version);
  const manifest = isRecord(value.package_manifest) ? value.package_manifest : {};
  const manifestUrl = stringValue(value.manifest_url) ?? stringValue(manifest.ref);
  const manifestSha256 = normalizedSha256(value.manifest_sha256 ?? manifest.sha256);
  if (!packageVersion || !manifestUrl || !manifestSha256) return null;
  const manifestJson = typeof value.manifest_json === 'string'
    ? value.manifest_json
    : typeof manifest.manifest_json === 'string'
      ? manifest.manifest_json
      : null;
  const payloadManifestJson = typeof value.payload_manifest_json === 'string'
    ? value.payload_manifest_json
    : null;
  const payloadManifestSha256 = normalizedSha256(value.payload_manifest_sha256);
  return {
    package_version: packageVersion,
    manifest_url: manifestUrl,
    manifest_sha256: manifestSha256,
    manifest_json: manifestJson,
    payload_manifest_json: payloadManifestJson,
    payload_manifest_sha256: payloadManifestSha256,
    content_digest: stringValue(value.content_digest),
    payload_digest: stringValue(value.payload_digest),
    source_artifact_ref: stringValue(value.source_artifact_ref),
    artifact_digest: normalizedSha256(value.artifact_digest),
    artifact_status: stringValue(value.artifact_status),
    package_content_digest: normalizedSha256(value.package_content_digest),
    owner_source_commit: stringValue(value.owner_source_commit),
    dependency_package_ids: Array.isArray(value.dependency_package_ids)
      ? value.dependency_package_ids.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [],
    selection_status: value.selection_status === 'retained_history'
      ? 'retained_history'
      : 'selected_for_release_set',
  };
}

export function normalizeManagedPackageCatalog(payload: unknown): ManagedPackageCatalog {
  const packageCatalog = releaseSetPackageCatalog(payload);
  if (!packageCatalog) {
    throw new FrameworkContractError('contract_shape_invalid', 'Managed Package source must declare a Package owner catalog.', {
      failure_code: 'agent_package_catalog_invalid',
    });
  }
  const result = new Map<string, ManagedCatalogEntry>();
  for (const [packageId, rawEntry] of Object.entries(packageCatalog)) {
    if (!isRecord(rawEntry) || !Array.isArray(rawEntry.versions)) continue;
    const versions = recordList(rawEntry.versions)
      .map((entry) => normalizeCatalogVersion(entry))
      .filter((entry): entry is ManagedCatalogVersion => Boolean(entry));
    if (versions.length === 0) continue;
    const selectedVersion = stringValue(rawEntry.selected_version);
    if (!selectedVersion || !versions.some((version) => version.package_version === selectedVersion)) {
      throw new FrameworkContractError('contract_shape_invalid', 'Managed Package catalog entry must select an exact declared version.', {
        package_id: packageId,
        selected_version: selectedVersion,
        available_versions: versions.map((version) => version.package_version),
        failure_code: 'agent_package_catalog_selection_invalid',
      });
    }
    result.set(packageId, {
      package_id: packageId,
      package_role: rawEntry.package_role === 'capability_package'
        ? 'capability_package'
        : rawEntry.package_role === 'workflow_profile'
          ? 'workflow_profile'
          : 'standard_agent',
      selected_version: selectedVersion,
      versions,
    });
  }
  return result;
}

function selectedCatalogVersion(
  catalog: ManagedPackageCatalog,
  packageId: string,
  kind: 'root_package' | 'capability_provider',
) {
  const entry = catalog.get(packageId);
  if (!entry) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      kind === 'root_package'
        ? 'Managed package catalog does not contain the requested root package.'
        : 'Managed package catalog does not contain the requested capability provider.',
      {
        package_id: packageId,
        failure_code: kind === 'root_package'
          ? 'agent_package_catalog_root_missing'
          : 'agent_package_catalog_capability_provider_missing',
        ...(kind === 'root_package'
          ? { update_action: `opl packages update ${publicAgentPackageSelector(packageId)}` }
          : {}),
      },
    );
  }
  const selected = entry.versions.find(
    (candidate) => candidate.package_version === entry.selected_version,
  );
  if (!selected) {
    throw new FrameworkContractError('contract_shape_invalid', 'Managed Package catalog selection is not present in its version set.', {
      package_id: packageId,
      selected_version: entry.selected_version,
      failure_code: 'agent_package_catalog_selection_invalid',
    });
  }
  return selected;
}

export function selectManagedCatalogPackageVersion(
  catalog: ManagedPackageCatalog,
  packageId: string,
  _input: { currentBaseAbi?: string | null } = {},
) {
  return selectedCatalogVersion(catalog, packageId, 'root_package');
}

export function catalogManifestPayload(version: ManagedCatalogVersion) {
  if (version.manifest_json) {
    const actualManifestSha256 = sha256(version.manifest_json);
    if (actualManifestSha256 !== version.manifest_sha256) {
      throw new FrameworkContractError('contract_shape_invalid', 'Managed package catalog inline manifest digest is invalid.', {
        package_version: version.package_version,
        expected_manifest_sha256: version.manifest_sha256,
        actual_manifest_sha256: actualManifestSha256,
        failure_code: 'agent_package_catalog_manifest_digest_mismatch',
      });
    }
    return parseJsonText(version.manifest_json);
  }
  return null;
}
