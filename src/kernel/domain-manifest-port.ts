/**
 * Structural port for domain manifest projections.
 *
 * The Atlas catalog owns construction and normalization. Lower layers only
 * consume this read-only shape and receive the loader from the Host.
 */
import type { FrameworkContracts } from './types.ts';

export type DomainManifestRecord = any;

export type DomainManifestStatus =
  | 'not_bound'
  | 'workspace_missing'
  | 'manifest_not_configured'
  | 'managed_contract_unavailable'
  | 'managed_contract_invalid'
  | 'command_failed'
  | 'command_timeout'
  | 'invalid_json'
  | 'invalid_manifest'
  | 'resolved';

export type DomainManifestCatalogEntry = {
  project_id: string;
  project: string;
  binding_id: string | null;
  workspace_path: string | null;
  manifest_command: string | null;
  status: DomainManifestStatus;
  manifest: DomainManifestRecord | null;
  error: any;
  [key: string]: any;
};

export type DomainManifestCatalog = {
  summary: any;
  projects: DomainManifestCatalogEntry[];
  notes: string[];
  [key: string]: any;
};

export type DomainManifestCatalogOptions = {
  manifestCommandTimeoutMs?: number;
  manifestCommandTimeoutPolicy?: 'env_or_default' | 'fixed';
  materializeFamilyTransitions?: boolean;
  transitionMaterializationTimeoutMs?: number;
  useProjectionCacheOnFailure?: boolean;
  writeProjectionCache?: boolean;
  resolveActiveWorkspaceBinding?: (projectId: string) => any;
};

export type DomainManifestCatalogLoader = (
  contracts: FrameworkContracts,
  options?: any,
) => DomainManifestCatalog;

export function emptyDomainManifestCatalog(): DomainManifestCatalog {
  return {
    summary: {
      total_projects_count: 0,
      resolved_count: 0,
      manifest_catalog_status: 'not_injected',
    },
    projects: [],
    notes: ['domain_manifest_catalog_not_injected'],
  };
}
