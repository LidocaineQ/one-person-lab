import path from 'node:path';

import { FrameworkContractError } from '../../../kernel/contract-validation.ts';
import {
  discoverInstalledCodexPluginDescriptors,
} from './installed-codex-plugin-directory.ts';
import {
  cleanupUnreferencedPackagePayloadSources,
  removePhysicalCodexSurface,
} from './physical-surface.ts';
import {
  readLockIndex,
  withAgentPackageLifecycleTransaction,
  writePackageTransaction,
} from './store.ts';
import { resolveCodexHome } from './shared.ts';
import type {
  AgentPackageLock,
  AgentPackageLockIndex,
} from './types.ts';
import type {
  ConfiguredCodexPluginCarrierReadback,
} from './configured-codex-plugin-carrier.ts';

export type DescriptorOwnedLegacyStateRetirement = {
  surface_kind: 'opl_descriptor_owned_legacy_state_retirement.v1';
  status: 'not_present' | 'retained' | 'validated_no_write' | 'retired';
  package_id: string;
  reason: string | null;
  descriptor_source_path: string | null;
  writes_performed: boolean;
  mutation_required: boolean;
  retired: {
    package_lock: boolean;
    physical_paths: string[];
  };
  retained: {
    package_lock: boolean;
  };
};

type ConfiguredRepairReadback = {
  status: string;
  package_id: string;
  configured_carrier: ConfiguredCodexPluginCarrierReadback;
};

function pathsOverlap(left: string, right: string) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return resolvedLeft === resolvedRight
    || resolvedLeft.startsWith(`${resolvedRight}${path.sep}`)
    || resolvedRight.startsWith(`${resolvedLeft}${path.sep}`);
}

function physicalSurfaceStillReferenced(
  index: AgentPackageLockIndex,
  retiredLock: AgentPackageLock,
) {
  const retired = retiredLock.physical_surface;
  if (!retired) return false;
  return index.packages.some((lock) => {
    const retained = lock.physical_surface;
    return Boolean(
      retained
      && (
        (retired.marketplace_root && retained.marketplace_root === retired.marketplace_root)
        || (
          retired.plugin_id
          && retired.marketplace_id
          && retained.plugin_id === retired.plugin_id
          && retained.marketplace_id === retired.marketplace_id
        )
      )
    );
  });
}

function currentHomePackageLock(index: AgentPackageLockIndex, packageId: string) {
  const currentCodexHome = path.resolve(resolveCodexHome());
  return index.packages.find((lock) => {
    if (lock.package_id !== packageId) return false;
    const lockCodexHome = lock.physical_surface?.codex_home;
    return !lockCodexHome || path.resolve(lockCodexHome) === currentCodexHome;
  }) ?? null;
}

function buildRetirementPlan(
  index: AgentPackageLockIndex,
  currentLock: AgentPackageLock | null,
  retainedReason: string | null,
) {
  if (!currentLock || retainedReason) {
    return {
      nextIndex: index,
      mutationRequired: false,
      retainedPackageLock: Boolean(currentLock),
    };
  }
  return {
    nextIndex: {
      ...index,
      packages: index.packages.filter((lock) => lock !== currentLock),
    },
    mutationRequired: true,
    retainedPackageLock: false,
  };
}

function retentionReason(
  packageId: string,
  index: AgentPackageLockIndex,
  currentLock: AgentPackageLock | null,
  descriptorSourcePath: string,
  carrier: ConfiguredCodexPluginCarrierReadback,
) {
  const dependent = index.packages.find((lock) =>
    lock.package_id !== packageId
    && lock.resolved_dependencies.some((entry) => entry.package_id === packageId)
  );
  if (dependent) return `retained_by_package_dependency:${dependent.package_id}`;
  if (
    currentLock
    && (
      currentLock.scope_materializations.length > 0
      || currentLock.runtime_source_carrier
      || currentLock.managed_runtime_source
    )
  ) {
    return 'retained_by_runtime_or_scope_materialization';
  }
  const retiredLocks = currentLock ? [currentLock] : [];
  const nativeMarketplaceSource = carrier.carrier.observed_sources.find(
    (entry) => entry.plugin_source_path === descriptorSourcePath,
  )?.marketplace_source ?? null;
  for (const lock of retiredLocks) {
    const surface = lock.physical_surface;
    const physicalPaths = [
      surface?.marketplace_root,
      surface?.marketplace_plugin_path,
      surface?.codex_plugin_cache_path,
      surface?.plugin_payload_cache_path,
    ].filter((entry): entry is string => Boolean(entry));
    if (physicalPaths.some((entry) => pathsOverlap(entry, descriptorSourcePath))) {
      return 'retained_to_protect_native_descriptor_source';
    }
    if (
      nativeMarketplaceSource
      && surface?.marketplace_root
      && pathsOverlap(nativeMarketplaceSource, surface.marketplace_root)
    ) {
      return 'retained_to_protect_native_marketplace_source';
    }
  }
  return null;
}

function legacySurfaceSharesNativeSelector(
  lock: AgentPackageLock,
  carrier: ConfiguredCodexPluginCarrierReadback,
) {
  const surface = lock.physical_surface;
  return Boolean(
    surface?.plugin_id
    && surface.marketplace_id
    && carrier.carrier.plugin_id === `${surface.plugin_id}@${surface.marketplace_id}`,
  );
}

function retireDescriptorOwnedLegacyState(input: {
  packageId: string;
  carrier: ConfiguredCodexPluginCarrierReadback;
  dryRun: boolean;
}): DescriptorOwnedLegacyStateRetirement {
  const descriptor = discoverInstalledCodexPluginDescriptors({
    packageId: input.packageId,
    failClosedOnCarrierError: true,
  }).get(input.packageId) ?? null;
  const descriptorSourcePath = descriptor?.sourcePath ?? null;
  const exactObservedSource = descriptorSourcePath
    ? input.carrier.carrier.observed_sources.some((entry) =>
        entry.plugin_source_path === descriptorSourcePath
        && entry.plugin_id === input.carrier.carrier.plugin_id
      )
    : false;
  if (
    !descriptor
    || !descriptorSourcePath
    || descriptor.manifest.package_id !== input.packageId
    || input.carrier.status !== 'installed'
    || input.carrier.executor.status !== 'callable'
    || input.carrier.carrier.precedence !== 'exact_single_source'
    || !exactObservedSource
  ) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Descriptor-owned legacy state retirement requires one fresh callable native owner descriptor.',
      {
        package_id: input.packageId,
        failure_code: 'descriptor_owned_legacy_state_retirement_not_native_confirmed',
      },
    );
  }

  const index = readLockIndex();
  const currentLock = currentHomePackageLock(index, input.packageId);
  const retainedReason = retentionReason(
    input.packageId,
    index,
    currentLock,
    descriptorSourcePath,
    input.carrier,
  );
  const {
    nextIndex,
    mutationRequired,
    retainedPackageLock,
  } = buildRetirementPlan(index, currentLock, retainedReason);
  const result: DescriptorOwnedLegacyStateRetirement = {
    surface_kind: 'opl_descriptor_owned_legacy_state_retirement.v1',
    status: retainedReason
      ? 'retained'
      : !mutationRequired
        ? 'not_present'
        : input.dryRun
          ? 'validated_no_write'
          : 'retired',
    package_id: input.packageId,
    reason: retainedReason,
    descriptor_source_path: descriptorSourcePath,
    writes_performed: mutationRequired && !input.dryRun,
    mutation_required: mutationRequired,
    retired: {
      package_lock: mutationRequired,
      physical_paths: [],
    },
    retained: {
      package_lock: retainedPackageLock,
    },
  };
  if (!mutationRequired || input.dryRun) return result;

  writePackageTransaction(nextIndex, {
    removeEmptyAuthorities: true,
  });
  try {
    const retiredLocks = currentLock ? [currentLock] : [];
    const legacySurfaceRemovals = retiredLocks.flatMap((lock) => {
      if (physicalSurfaceStillReferenced(nextIndex, lock)) return [];
      const surface = removePhysicalCodexSurface(
        lock.physical_surface,
        false,
        lock.package_id,
        {
          retainPayloadSource: true,
          retainPluginCache: true,
          retainCodexRegistration: legacySurfaceSharesNativeSelector(lock, input.carrier),
        },
      );
      return surface.removed_paths;
    });
    const unreferencedRemovals = cleanupUnreferencedPackagePayloadSources(index, nextIndex, {
      protectedPaths: new Set([descriptorSourcePath]),
    });
    result.retired.physical_paths = [
      ...new Set([...legacySurfaceRemovals, ...unreferencedRemovals]),
    ];
  } catch (error) {
    writePackageTransaction(index);
    throw error;
  }
  return result;
}

export async function maybeRetireDescriptorOwnedLegacyState(input: {
  configured: ConfiguredRepairReadback;
  dryRun: boolean;
}) {
  if (
    input.configured.status !== 'installed'
    && input.configured.status !== 'repaired'
    && input.configured.status !== 'updated'
    && input.configured.status !== 'validated_no_write'
  ) {
    return {
      surface_kind: 'opl_descriptor_owned_legacy_state_retirement.v1',
      status: 'retained',
      package_id: input.configured.package_id,
      reason: 'native_repair_not_confirmed',
      descriptor_source_path: input.configured.configured_carrier.plugin_source_path,
      writes_performed: false,
      mutation_required: false,
      retired: {
        package_lock: false,
        physical_paths: [],
      },
      retained: {
        package_lock: false,
      },
    } satisfies DescriptorOwnedLegacyStateRetirement;
  }
  const preview = retireDescriptorOwnedLegacyState({
    packageId: input.configured.package_id,
    carrier: input.configured.configured_carrier,
    dryRun: true,
  });
  if (input.dryRun || !preview.mutation_required || preview.status === 'retained') {
    return preview;
  }
  return withAgentPackageLifecycleTransaction(false, async () =>
    retireDescriptorOwnedLegacyState({
      packageId: input.configured.package_id,
      carrier: input.configured.configured_carrier,
      dryRun: false,
    })
  );
}
