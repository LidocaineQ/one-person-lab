import type { JsonRecord } from '../../kernel/json-record.ts';
import {
  createOplAgentPackageStatusReader,
  listOplAgentPackages,
  readInstalledStandardAgentDescriptorForPackage,
} from '../../adapters/integration/public/app-state.ts';
import { listWorkspaceBindings } from '../../authority/workspace/public/app-state.ts';
import { projectRuntimeAgentPackageDirectoryEntry } from './app-state-agent-packages.ts';
import { buildAppRuntimeWorkItemProjection } from './app-runtime-work-item-projection.ts';
import type { InventoryDescriptorResolver } from './work-item-projection/inventory.ts';

const RUNTIME_READ_POLICY = 'local_inventory_and_execution_session_sqlite_plus_fresh_cached_runtime_observation_only';
export const APP_RUNTIME_STATE_PROFILE_V1_CAPABILITY_ID = 'opl_app.runtime_state_profile.v1';

function nowIso() {
  return new Date().toISOString();
}

function normalizedIdentity(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function errorDiagnostic(error: unknown) {
  return {
    code: error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'unexpected_error',
    message: error instanceof Error ? error.message : 'Descriptor read failed.',
  };
}

function descriptorWithReservedPackageAliasesRemoved(
  descriptor: NonNullable<ReturnType<typeof readInstalledStandardAgentDescriptorForPackage>>,
  packageId: string,
  reservedPackageIds: ReadonlySet<string>,
) {
  const packageIdentity = normalizedIdentity(packageId);
  const hardIdentities = [
    descriptor.agent_id ?? '',
    descriptor.domain_id,
    descriptor.interface.runtime.runtime_domain_id,
  ]
    .map(normalizedIdentity)
    .filter(Boolean);
  if (
    hardIdentities.some(
      (identity) => identity !== packageIdentity && reservedPackageIds.has(identity),
    )
  ) {
    return null;
  }
  return {
    ...descriptor,
    interface: {
      ...descriptor.interface,
      routing: {
        ...descriptor.interface.routing,
        explicit_aliases: descriptor.interface.routing.explicit_aliases.filter((alias) => {
          const identity = normalizedIdentity(alias);
          return identity === packageIdentity || !reservedPackageIds.has(identity);
        }),
      },
    },
  };
}

export type BuildOplRuntimeAppStateInput = {
  generatedAt?: string;
  now?: () => number;
  listPackages?: typeof listOplAgentPackages;
  createPackageStatusReader?: typeof createOplAgentPackageStatusReader;
  readDescriptor?: typeof readInstalledStandardAgentDescriptorForPackage;
  listBindings?: typeof listWorkspaceBindings;
  buildProjection?: typeof buildAppRuntimeWorkItemProjection;
};

function buildRuntimeProjectionDependencies(input: BuildOplRuntimeAppStateInput) {
  const packageProjectionItems: JsonRecord[] = [];
  const packageStatusById: Record<string, JsonRecord> = {};
  const diagnostics: JsonRecord[] = [];
  const descriptorByPackage = new Map<
    string,
    ReturnType<typeof readInstalledStandardAgentDescriptorForPackage>
  >();
  const descriptorByIdentity = new Map<
    string,
    ReturnType<typeof readInstalledStandardAgentDescriptorForPackage>
  >();
  const listPackages = input.listPackages ?? listOplAgentPackages;
  const createPackageStatusReader = input.createPackageStatusReader
    ?? createOplAgentPackageStatusReader;
  const readDescriptor = input.readDescriptor ?? readInstalledStandardAgentDescriptorForPackage;
  const readPackageStatus = createPackageStatusReader();
  const directory = listPackages({
    detail: 'fast',
  }).opl_agent_packages.directory;
  const installedAgentEntries = directory.entries.filter(
    (entry) => entry.installed && entry.package_role === 'standard_agent',
  );
  const packageIdCounts = new Map<string, number>();
  for (const entry of installedAgentEntries) {
    const identity = normalizedIdentity(entry.package_id);
    packageIdCounts.set(identity, (packageIdCounts.get(identity) ?? 0) + 1);
  }
  const reservedPackageIds = new Set(packageIdCounts.keys());

  for (const entry of installedAgentEntries) {
    const projection = projectRuntimeAgentPackageDirectoryEntry(entry);
    packageProjectionItems.push(projection.packageProjectionItem);
    packageStatusById[entry.package_id] = projection.packageStatus;
    const packageIdentity = normalizedIdentity(entry.package_id);
    if ((packageIdCounts.get(packageIdentity) ?? 0) > 1) {
      diagnostics.push({
        reason: 'runtime_agent_package_identity_ambiguous',
        agent_id: entry.package_id,
        ref: entry.readiness.detail_surface,
        details: {
          package_id: entry.package_id,
          normalized_package_id: packageIdentity,
        },
      });
      continue;
    }
    if (entry.readiness.status_read_error) {
      diagnostics.push({
        reason: 'runtime_agent_package_status_read_failed',
        agent_id: entry.package_id,
        ref: entry.readiness.detail_surface,
        details: {
          package_id: entry.package_id,
          status_read_error: entry.readiness.status_read_error,
        },
      });
    }
    try {
      const read = readDescriptor(entry.package_id, readPackageStatus);
      const descriptor = read
        ? descriptorWithReservedPackageAliasesRemoved(read, entry.package_id, reservedPackageIds)
        : null;
      if (!descriptor) {
        diagnostics.push({
          reason: 'runtime_agent_descriptor_unavailable',
          agent_id: entry.package_id,
          ref: entry.readiness.detail_surface,
          details: { package_id: entry.package_id },
        });
        continue;
      }
      descriptorByPackage.set(packageIdentity, descriptor);
      for (const identity of [
        descriptor.agent_id ?? '',
        descriptor.domain_id,
        descriptor.interface.runtime.runtime_domain_id,
        ...descriptor.interface.routing.explicit_aliases,
      ]) {
        const normalized = normalizedIdentity(identity);
        if (normalized && !reservedPackageIds.has(normalized)) {
          if (!descriptorByIdentity.has(normalized)) {
            descriptorByIdentity.set(normalized, descriptor);
          } else if (descriptorByIdentity.get(normalized) !== descriptor) {
            descriptorByIdentity.set(normalized, null);
          }
        }
      }
    } catch (error) {
      diagnostics.push({
        reason: 'runtime_agent_descriptor_read_failed',
        agent_id: entry.package_id,
        ref: entry.readiness.detail_surface,
        details: {
          package_id: entry.package_id,
          descriptor_read_error: errorDiagnostic(error),
        },
      });
    }
  }

  const resolveDescriptor: InventoryDescriptorResolver = (agentId) => {
    const identity = normalizedIdentity(agentId);
    return descriptorByPackage.get(identity) ?? descriptorByIdentity.get(identity) ?? null;
  };

  return { packageProjectionItems, packageStatusById, resolveDescriptor, diagnostics };
}

export function buildOplRuntimeAppState(input: BuildOplRuntimeAppStateInput = {}) {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const generatedAt = input.generatedAt ?? nowIso();
  const bindings = (input.listBindings ?? listWorkspaceBindings)();
  const dependencies = buildRuntimeProjectionDependencies(input);
  const projectedWorkItems = (input.buildProjection ?? buildAppRuntimeWorkItemProjection)({
    profile: 'fast',
    generatedAt,
    bindings,
    ...dependencies,
  });
  const workItemProjectionV2 = dependencies.diagnostics.length === 0
    ? projectedWorkItems
    : {
        ...projectedWorkItems,
        diagnostics: {
          ...projectedWorkItems.diagnostics,
          count: projectedWorkItems.diagnostics.count + dependencies.diagnostics.length,
          items: projectedWorkItems.diagnostics.detail_policy === 'included'
            ? [...projectedWorkItems.diagnostics.items, ...dependencies.diagnostics]
            : projectedWorkItems.diagnostics.items,
        },
      };

  return {
    version: 'g2',
    app_state: {
      schema_version: 'opl_app_state.v1',
      surface_kind: 'opl_app_state.v1',
      meta: {
        profile: 'runtime',
        capabilities: [APP_RUNTIME_STATE_PROFILE_V1_CAPABILITY_ID],
        projection_detail_profile: 'fast',
        generated_at: generatedAt,
        elapsed_ms: now() - startedAt,
        read_policy: RUNTIME_READ_POLICY,
        network_access_allowed: false,
        mutation_allowed: false,
        temporal_reconciliation_mode: 'background_updates_local_runtime_observation_gui_reads_cache_only',
      },
      operator: {
        workbench: {
          work_item_projection_v2: workItemProjectionV2,
        },
      },
    },
  };
}
