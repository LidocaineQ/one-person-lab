import path from 'node:path';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import {
  runOplBundledFullRuntimeAgentPackageInstall,
  runOplBundledFullRuntimeAgentPackageUpdate,
} from '../agent-package-registry.ts';
import {
  readBundledFullRuntimePackageCatalog,
  resolveBundledFullRuntimePackageRoot,
  type BundledFullRuntimeCatalogEntry,
  type BundledFullRuntimePackageCatalog,
} from '../agent-package-registry-parts/bundled-full-runtime-catalog.ts';
import {
  readInstalledCarrierEntries,
  type InstalledCarrierEntry,
} from '../agent-package-registry-parts/installed-codex-plugin-directory.ts';
import { managedPolicyCurrentnessFromDescriptor } from '../agent-package-registry-parts/managed-policy-surface.ts';
import { normalizePackageManifest } from '../agent-package-registry-parts/manifest-normalizers.ts';
import {
  inspectMaterializedPhysicalCodexSurface,
  materializePhysicalCodexSurface,
  resolveBundledFullRuntimeManifestPhysicalSource,
} from '../agent-package-registry-parts/physical-surface.ts';
import type {
  AgentPackageLock,
  AgentPackageManifest,
} from '../agent-package-registry-parts/types.ts';

type FullRuntimePackageInstaller = typeof runOplBundledFullRuntimeAgentPackageInstall;
type FullRuntimePackageUpdater = typeof runOplBundledFullRuntimeAgentPackageUpdate;
type FullRuntimePackageMaterializer = (input: {
  manifest: AgentPackageManifest;
  dryRun: boolean;
}) => ReturnType<typeof materializePhysicalCodexSurface>;

type FullRuntimePackageReconciliationOptions = {
  installPackage?: FullRuntimePackageInstaller;
  updatePackage?: FullRuntimePackageUpdater;
  materializePackage?: FullRuntimePackageMaterializer;
  readCatalog?: () => BundledFullRuntimePackageCatalog;
  readInstalledCarrierEntries?: () => InstalledCarrierEntry[];
  inspectMaterializedSurface?: typeof inspectMaterializedPhysicalCodexSurface;
  inspectManagedPolicy?: typeof managedPolicyCurrentnessFromDescriptor;
  lifecycleAction?: 'install' | 'update';
  operationId?: string;
  requireSourceRoots?: boolean;
};

function fail(message: string, details: Record<string, unknown>): never {
  throw new FrameworkContractError('contract_shape_invalid', message, {
    ...details,
    failure_code: details.failure_code ?? 'full_runtime_package_reconciliation_incomplete',
  });
}

function failureReadback(error: unknown, packageId: string | null = null) {
  if (error instanceof FrameworkContractError) {
    return {
      package_id: packageId,
      code: error.code,
      message: error.message,
      failure_code: typeof error.details?.failure_code === 'string'
        ? error.details.failure_code
        : 'full_runtime_package_reconciliation_incomplete',
      details: error.details ?? {},
    };
  }
  return {
    package_id: packageId,
    code: 'unexpected_error',
    message: error instanceof Error ? error.message : String(error),
    failure_code: 'full_runtime_package_reconciliation_incomplete',
    details: {},
  };
}

function normalizedSha256(value: string | null | undefined) {
  return value?.replace(/^sha256:/, '') ?? null;
}

function rootTargetIdentity(
  catalog: BundledFullRuntimePackageCatalog,
  packageId: string,
) {
  const entry = catalog.entries.get(packageId)!;
  return {
    target_version: entry.packageVersion,
    target_manifest_sha256: normalizedSha256(entry.manifestSha256),
    target_owner_source_commit: entry.ownerSourceCommit,
    release_catalog_ref: catalog.catalogRef,
    release_catalog_digest: catalog.catalogSha256,
  };
}

function materializedCatalogManifest(entry: BundledFullRuntimeCatalogEntry): AgentPackageManifest {
  const manifest = normalizePackageManifest(parseJsonText(entry.manifestJson), entry.manifestUrl);
  const payload = parseJsonText(entry.payloadManifestJson);
  const contentLock = isRecord(payload) && isRecord(payload.content_lock)
    ? payload.content_lock
    : null;
  const digest = typeof contentLock?.digest === 'string' ? contentLock.digest : null;
  const canonicalization = contentLock?.canonicalization;
  const files = isRecord(payload) && Array.isArray(payload.files) ? payload.files : null;
  const contentLockPaths = files?.flatMap((value) =>
    isRecord(value) && typeof value.path === 'string' && value.path.trim() ? [value.path.trim()] : []);
  if (
    !digest
    || !/^sha256:[0-9a-f]{64}$/.test(digest)
    || (canonicalization !== 'ordered_path_nul_file_bytes'
      && canonicalization !== 'ordered_path_length_file_length_bytes')
    || !files
    || contentLockPaths?.length !== files.length
  ) {
    fail('Bundled Full runtime catalog payload has no canonical materialized-byte identity.', {
      package_id: entry.packageId,
      payload_manifest_url: entry.payloadManifestUrl,
      failure_code: 'agent_package_bundled_payload_content_lock_missing',
    });
  }
  return {
    ...manifest,
    content_digest: digest,
    content_lock_canonicalization: canonicalization as NonNullable<
      AgentPackageManifest['content_lock_canonicalization']
    >,
    content_lock_paths: contentLockPaths,
  };
}

function assertMutationClosure(
  locks: AgentPackageLock[],
  rootPackageId: string,
  catalog: BundledFullRuntimePackageCatalog,
) {
  for (const lock of locks) {
    if (!catalog.entries.has(lock.package_id)) {
      fail('Managed bundled Full runtime update returned a lock outside the catalog closure.', {
        package_id: rootPackageId,
        updated_package_id: lock.package_id,
        failure_code: 'full_runtime_package_batch_result_invalid',
      });
    }
  }
}

function catalogEntryCarriesOwnerDescriptor(entry: BundledFullRuntimeCatalogEntry) {
  const payload = parseJsonText(entry.payloadManifestJson);
  return isRecord(payload)
    && Array.isArray(payload.files)
    && payload.files.some((file) => isRecord(file) && file.path === 'opl-package.json');
}

function pluginBareName(pluginId: string) {
  return pluginId.split('@', 1)[0] ?? pluginId;
}

type MaterializedProjection = ReturnType<typeof inspectMaterializedPhysicalCodexSurface>;
type CurrentProjection = {
  manifest: AgentPackageManifest;
  surface: MaterializedProjection | null;
  nativeCarrier: InstalledCarrierEntry | null;
  managedPolicy: ReturnType<typeof managedPolicyCurrentnessFromDescriptor> | null;
  error: unknown | null;
  carrierReadFailed: boolean;
};

function assertNativeCarrierProjection(
  manifest: AgentPackageManifest,
  surface: MaterializedProjection,
  entries: InstalledCarrierEntry[],
) {
  const pluginId = manifest.plugin_id!;
  const matchingEntries = entries.filter((entry) => pluginBareName(entry.pluginId) === pluginId);
  if (manifest.codex_default_exposure === false) {
    if (matchingEntries.length > 0) {
      fail('Hidden bundled Full runtime Package is unexpectedly exposed by the native carrier.', {
        package_id: manifest.package_id,
        plugin_id: pluginId,
        native_plugin_ids: matchingEntries.map((entry) => entry.pluginId),
        failure_code: 'full_runtime_package_projection_incomplete',
      });
    }
    return null;
  }
  const expectedPluginId = `${pluginId}@${surface.marketplace_id}`;
  const expectedSourcePath = path.resolve(surface.marketplace_plugin_path!);
  if (
    matchingEntries.length !== 1
    || matchingEntries[0].pluginId !== expectedPluginId
    || !matchingEntries[0].enabled
    || path.resolve(matchingEntries[0].sourcePath) !== expectedSourcePath
  ) {
    fail('Bundled Full runtime Package native carrier projection is missing, disabled, ambiguous, or stale.', {
      package_id: manifest.package_id,
      plugin_id: pluginId,
      expected_plugin_id: expectedPluginId,
      expected_source_path: expectedSourcePath,
      native_entries: matchingEntries,
      failure_code: 'full_runtime_package_projection_incomplete',
    });
  }
  return matchingEntries[0];
}

function catalogClosure(
  catalog: BundledFullRuntimePackageCatalog,
  rootPackageId: string,
) {
  const closure: string[] = [];
  const visited = new Set<string>();
  const visit = (packageId: string) => {
    if (visited.has(packageId)) return;
    const entry = catalog.entries.get(packageId);
    if (!entry) {
      fail('Bundled Full runtime package dependency is absent from the catalog.', {
        root_package_id: rootPackageId,
        package_id: packageId,
      });
    }
    visited.add(packageId);
    for (const dependencyId of entry.dependencyPackageIds) visit(dependencyId);
    closure.push(packageId);
  };
  visit(rootPackageId);
  return closure;
}

function rootPackageIds(catalog: BundledFullRuntimePackageCatalog) {
  const dependencies = new Set(
    [...catalog.entries.values()].flatMap((entry) => entry.dependencyPackageIds),
  );
  return [...catalog.entries.values()]
    .filter((entry) => entry.packageRole !== 'capability_package')
    .map((entry) => entry.packageId)
    .filter((packageId) => !dependencies.has(packageId))
    .sort();
}

function resolvePackageRoots(
  catalog: BundledFullRuntimePackageCatalog,
  env: NodeJS.ProcessEnv,
) {
  const runtimeHome = env.OPL_FULL_RUNTIME_HOME?.trim();
  const roots: Record<string, string> = {};
  for (const entry of catalog.entries.values()) {
    const candidate = resolveBundledFullRuntimePackageRoot(entry, env);
    if (candidate) roots[entry.packageId] = candidate;
  }
  return { runtimeHome: runtimeHome ?? null, roots };
}

async function reconcileBundledFullRuntimePackages(
  env: NodeJS.ProcessEnv,
  options: FullRuntimePackageReconciliationOptions,
) {
  const runtimeHome = env.OPL_FULL_RUNTIME_HOME?.trim();
  const catalog = (options.readCatalog ?? readBundledFullRuntimePackageCatalog)();
  const hasExplicitPackageRoot = [...catalog.entries.values()]
    .some((entry) => Boolean(resolveBundledFullRuntimePackageRoot(entry, {
      ...env,
      OPL_FULL_RUNTIME_HOME: undefined,
    })));
  if (!runtimeHome && !hasExplicitPackageRoot && !options.requireSourceRoots) return null;

  const lifecycleAction = options.lifecycleAction ?? 'install';
  const operationId = options.operationId?.trim()
    || `opl://managed-update/bundled-full-runtime/${normalizedSha256(catalog.catalogSha256)}`;
  const packageIds = [...catalog.entries.keys()];
  const roots = rootPackageIds(catalog);
  const resolvedRoots = resolvePackageRoots(catalog, env);
  const manifests = new Map([...catalog.entries].map(([packageId, entry]) => [
    packageId,
    materializedCatalogManifest(entry),
  ]));
  const readCarrierEntries = options.readInstalledCarrierEntries
    ?? (() => readInstalledCarrierEntries({
      binary: env.OPL_CODEX_PLUGIN_BIN,
      env,
      failClosedOnCarrierError: true,
    }));
  const inspectMaterializedSurface = options.inspectMaterializedSurface
    ?? inspectMaterializedPhysicalCodexSurface;
  const inspectManagedPolicy = options.inspectManagedPolicy
    ?? managedPolicyCurrentnessFromDescriptor;
  const readCurrentProjection = () => {
    let carrierEntries: InstalledCarrierEntry[];
    try {
      carrierEntries = readCarrierEntries();
    } catch (error) {
      return new Map<string, CurrentProjection>(packageIds.map((packageId) => [
        packageId,
        {
          manifest: manifests.get(packageId)!,
          surface: null,
          nativeCarrier: null,
          managedPolicy: null,
          error,
          carrierReadFailed: true,
        },
      ]));
    }
    return new Map<string, CurrentProjection>(packageIds.map((packageId) => {
      const manifest = manifests.get(packageId)!;
      try {
        const surface = inspectMaterializedSurface(manifest);
        const nativeCarrier = assertNativeCarrierProjection(manifest, surface, carrierEntries);
        const managedPolicy = inspectManagedPolicy({
          manifest,
          sourceRoot: surface.codex_plugin_cache_path,
        });
        if (managedPolicy.status !== 'current' && managedPolicy.status !== 'not_requested') {
          fail('Bundled Full runtime Package managed policy projection is not current.', {
            package_id: packageId,
            managed_policy_currentness: managedPolicy,
            failure_code: 'full_runtime_package_projection_incomplete',
          });
        }
        return [packageId, {
          manifest,
          surface,
          nativeCarrier,
          managedPolicy,
          error: null,
          carrierReadFailed: false,
        }] as const;
      } catch (error) {
        return [packageId, {
          manifest,
          surface: null,
          nativeCarrier: null,
          managedPolicy: null,
          error,
          carrierReadFailed: false,
        }] as const;
      }
    }));
  };
  let currentProjection = readCurrentProjection();
  const isCurrent = (packageId: string) => currentProjection.get(packageId)?.error === null;
  const verifyCurrentClosure = (rootPackageId: string, closure: string[]) => {
    currentProjection = readCurrentProjection();
    for (const packageId of closure) {
      const projection = currentProjection.get(packageId)!;
      if (projection.error) throw projection.error;
    }
    if (
      env.OPL_TEST_RUNTIME_SOURCE_FAULTS_ENABLED === '1'
      && env.OPL_TEST_MANAGED_BUNDLED_UPDATE_POST_VERIFY_FAIL_PACKAGE_ID === rootPackageId
    ) {
      fail('Injected failure after managed bundled package final verification.', {
        package_id: rootPackageId,
        mutation_started: true,
        failure_code: 'test_managed_bundled_update_post_verify_interrupted',
      });
    }
  };
  const touchedPackageIds = new Set<string>();
  const rootInstalls: Array<Record<string, unknown>> = [];
  const failures: ReturnType<typeof failureReadback>[] = [];
  const installPackage = options.installPackage ?? runOplBundledFullRuntimeAgentPackageInstall;
  const updatePackage = options.updatePackage ?? runOplBundledFullRuntimeAgentPackageUpdate;
  const materializePackage = options.materializePackage ?? ((input) =>
    materializePhysicalCodexSurface(input.manifest, input.dryRun));
  const rootClosures = new Map(roots.map((packageId) => [packageId, catalogClosure(catalog, packageId)]));
  const nativeMaterializationRoots = new Set(roots.filter((packageId) =>
    rootClosures.get(packageId)!.every((closurePackageId) =>
      catalogEntryCarriesOwnerDescriptor(catalog.entries.get(closurePackageId)!))));

  for (const packageId of roots) {
    const closure = rootClosures.get(packageId)!;
    const useNativeMaterialization = nativeMaterializationRoots.has(packageId);
    if (closure.every(isCurrent)) {
      rootInstalls.push({
        target_id: packageId,
        package_id: packageId,
        status: 'skipped',
        reason: 'catalog_identity_and_materialized_closure_current',
        action: null,
        result: null,
        ...rootTargetIdentity(catalog, packageId),
        dependency_transaction_id: null,
        dependency_package_ids: closure,
      });
      continue;
    }
    const completedPackageIds: string[] = [];
    try {
      const missingClosureRoots = closure.filter((closurePackageId) =>
        !resolvedRoots.roots[closurePackageId]);
      if (missingClosureRoots.length > 0) {
        throw new FrameworkContractError(
          'contract_shape_invalid',
          'Bundled Full runtime package mutation unit has incomplete source authority.',
          {
            package_id: packageId,
            runtime_home: resolvedRoots.runtimeHome,
            missing_package_ids: missingClosureRoots,
            dependency_package_ids: closure,
            mutation_started: false,
            failure_code: 'full_runtime_package_source_authority_incomplete',
          },
        );
      }
      const carrierReadFailure = closure
        .map((closurePackageId) => currentProjection.get(closurePackageId)!)
        .find((projection) => projection.carrierReadFailed);
      if (carrierReadFailure?.error) throw carrierReadFailure.error;
      if (!useNativeMaterialization) {
        let updateFinalVerificationCompleted = false;
        const result = lifecycleAction === 'update'
          ? await updatePackage({
              packageId,
              agentRoot: resolvedRoots.roots[packageId],
              packageRoots: resolvedRoots.roots,
              operationId,
              verifyAppliedPackageLocks: async (locks) => {
                assertMutationClosure(locks, packageId, catalog);
                verifyCurrentClosure(packageId, closure);
                updateFinalVerificationCompleted = true;
              },
            })
          : await installPackage({
              packageId,
              agentRoot: resolvedRoots.roots[packageId],
              packageRoots: resolvedRoots.roots,
            });
        const lifecycleResult = 'opl_agent_package_update' in result
          ? result.opl_agent_package_update
          : result.opl_agent_package_install;
        if (lifecycleAction === 'update' && !updateFinalVerificationCompleted) {
          fail('Managed bundled Full runtime updater returned before final verification completed.', {
            package_id: packageId,
            mutation_started: null,
            failure_code: 'full_runtime_package_final_verification_not_executed',
          });
        }
        if (lifecycleAction === 'install') {
          assertMutationClosure(lifecycleResult.dependency_package_locks, packageId, catalog);
          verifyCurrentClosure(packageId, closure);
        }
        for (const closurePackageId of closure) touchedPackageIds.add(closurePackageId);
        rootInstalls.push({
          target_id: packageId,
          package_id: packageId,
          status: 'completed',
          reason: lifecycleAction === 'update'
            ? 'package_mutation_unit_completed'
            : 'package_install_unit_completed',
          action: lifecycleAction,
          result: lifecycleResult,
          ...rootTargetIdentity(catalog, packageId),
          dependency_transaction_id: lifecycleResult.dependency_transaction_id,
          dependency_package_ids: lifecycleResult.dependency_package_locks
            .map((lock) => lock.package_id),
        });
        continue;
      }
      const pendingPackageIds = closure.filter((closurePackageId) => !isCurrent(closurePackageId));
      const physicalManifests = new Map(pendingPackageIds.map((closurePackageId) => [
        closurePackageId,
        options.materializePackage
          ? manifests.get(closurePackageId)!
          : resolveBundledFullRuntimeManifestPhysicalSource({
              manifest: manifests.get(closurePackageId)!,
              catalogEntry: catalog.entries.get(closurePackageId)!,
              packageRoot: resolvedRoots.roots[closurePackageId],
            }),
      ]));
      const physicalPreviews = new Map(pendingPackageIds.map((closurePackageId) => [
        closurePackageId,
        materializePackage({
          manifest: physicalManifests.get(closurePackageId)!,
          dryRun: true,
        }),
      ]));
      if (lifecycleAction === 'update') {
        for (const closurePackageId of pendingPackageIds) {
          const preview = physicalPreviews.get(closurePackageId)!;
          const serviceConflicts = preview.workflow_policy_migration.detected_conflicts
            .filter((entry) => entry.surface_kind === 'service');
          const profileRequiresOwnerMerge = preview.profile_migration.status === 'semantic_merge_required';
          if (profileRequiresOwnerMerge || serviceConflicts.length > 0) {
            throw new FrameworkContractError(
              'contract_shape_invalid',
              'Managed bundled package update requires an owner-visible profile or service migration.',
              {
                package_id: closurePackageId,
                profile_migration_status: preview.profile_migration.status,
                service_conflicts: serviceConflicts,
                mutation_started: false,
                failure_code: 'agent_package_bundled_managed_surface_manual_required',
              },
            );
          }
        }
      }
      const materializations: Array<Record<string, unknown>> = [];
      for (const closurePackageId of pendingPackageIds) {
        const surface = materializePackage({
          manifest: physicalManifests.get(closurePackageId)!,
          dryRun: false,
        });
        completedPackageIds.push(closurePackageId);
        touchedPackageIds.add(closurePackageId);
        materializations.push({
          package_id: closurePackageId,
          status: surface.status,
          writes_performed: surface.writes_performed,
          reload_required: surface.reload_required,
        });
      }
      verifyCurrentClosure(packageId, closure);
      rootInstalls.push({
        target_id: packageId,
        package_id: packageId,
        status: 'completed',
        reason: 'native_package_materialization_completed',
        action: lifecycleAction,
        result: {
          surface_kind: 'opl_full_runtime_native_package_materialization.v1',
          status: 'completed',
          package_materializations: materializations,
        },
        ...rootTargetIdentity(catalog, packageId),
        dependency_transaction_id: null,
        dependency_package_ids: closure,
      });
    } catch (error) {
      const initialFailure = failureReadback(error, packageId);
      const initialFailureDetails: Record<string, unknown> = isRecord(initialFailure.details)
        ? initialFailure.details
        : {};
      const failure = useNativeMaterialization
        ? {
            ...initialFailure,
            details: {
              ...initialFailureDetails,
              completed_package_ids: completedPackageIds,
              mutation_started: completedPackageIds.length > 0
                ? true
                : initialFailureDetails.mutation_started === false
                  ? false
                  : null,
              package_mutation_status: completedPackageIds.length > 0
                ? 'partially_materialized_retryable'
                : initialFailureDetails.package_mutation_status
                  ?? 'not_started_or_package_local_rollback',
              local_prestate_restored: null,
            },
          }
        : initialFailure;
      const failureDetails: Record<string, unknown> = isRecord(failure.details)
        ? failure.details
        : {};
      const manualRequired = failure.failure_code === 'agent_package_bundled_managed_surface_manual_required';
      const mutationStarted = failureDetails.mutation_started === true
        ? true
        : failureDetails.mutation_started === false
          ? false
          : null;
      const localPrestateRestored = failureDetails.local_prestate_restored === true
        ? true
        : failureDetails.local_prestate_restored === false
          ? false
          : null;
      failures.push(failure);
      rootInstalls.push({
        target_id: packageId,
        package_id: packageId,
        status: manualRequired ? 'manual_required' : 'failed',
        reason: manualRequired
          ? 'package_mutation_blocked_before_write'
          : useNativeMaterialization
            ? 'package_mutation_unit_failed_retryable'
            : 'package_mutation_unit_failed_without_rolling_back_other_roots',
        action: lifecycleAction,
        result: {
          failure,
          package_mutation_unit: {
            scope: useNativeMaterialization
              ? 'package_local_atomic_materialization_with_root_retry'
              : 'root_package_and_required_dependency_closure',
            status: typeof failureDetails.package_mutation_status === 'string'
              ? failureDetails.package_mutation_status
              : mutationStarted === false
                ? 'not_started'
                : 'unknown',
            local_prestate_restored: localPrestateRestored,
            mutation_started: mutationStarted,
          },
        },
        ...rootTargetIdentity(catalog, packageId),
        dependency_transaction_id: null,
        dependency_package_ids: closure,
      });
    }
  }

  currentProjection = readCurrentProjection();
  const items = packageIds.map((packageId) => {
    const projection = currentProjection.get(packageId)!;
    if (projection.error || !projection.surface) {
      const failure = failureReadback(projection.error, packageId);
      failures.push(failure);
      return {
        package_id: packageId,
        status: 'projection_incomplete' as const,
      };
    }
    const { surface, nativeCarrier, managedPolicy } = projection;
    return {
      package_id: packageId,
      status: touchedPackageIds.has(packageId) ? 'installed' as const : 'already_installed' as const,
      exposure_state: surface.codex_default_exposure ? 'visible' as const : 'hidden' as const,
      physical_surface_status: surface.status,
      plugin_id: surface.plugin_id,
      marketplace_id: surface.marketplace_id,
      marketplace_plugin_path: surface.marketplace_plugin_path,
      codex_plugin_cache_path: surface.codex_plugin_cache_path,
      materialized_required_skill_ids: surface.materialized_required_skill_ids,
      materialized_required_skill_paths: surface.materialized_required_skill_paths,
      native_carrier: nativeCarrier,
      managed_policy_currentness: managedPolicy,
    };
  });
  const completeItems = items.filter((item) =>
    item.status === 'installed' || item.status === 'already_installed'
  );
  const completedRootCount = rootInstalls.filter((entry) =>
    entry.status === 'completed' || entry.status === 'skipped').length;
  const failedRootCount = rootInstalls.filter((entry) => entry.status === 'failed').length;
  const manualRootCount = rootInstalls.filter((entry) => entry.status === 'manual_required').length;
  const unsuccessfulRootCount = failedRootCount + manualRootCount;
  const status = unsuccessfulRootCount === 0
    ? 'completed' as const
    : completedRootCount > 0
      ? 'partial' as const
      : 'failed' as const;
  const readback = {
    surface_kind: 'opl_full_runtime_package_reconciliation.v1' as const,
    status,
    orchestration_policy: 'fail_open_per_root_package' as const,
    package_mutation_policy: nativeMaterializationRoots.size === 0
      ? 'fail_closed_per_required_dependency_closure' as const
      : nativeMaterializationRoots.size === roots.length
        ? 'package_local_atomic_root_retryable' as const
        : 'per_root_native_materialization_with_legacy_compatibility' as const,
    lifecycle_action: lifecycleAction,
    catalog_ref: catalog.catalogRef,
    catalog_sha256: catalog.catalogSha256,
    root_package_ids: roots,
    summary: {
      total: items.length,
      installed: items.filter((item) => item.status === 'installed').length,
      already_installed: items.filter((item) => item.status === 'already_installed').length,
      installed_package_count: completeItems.length,
      materialized_package_count: completeItems.length,
      root_package_count: roots.length,
      completed_root_count: completedRootCount,
      manual_required_root_count: manualRootCount,
      failed_root_count: failedRootCount,
      failed_package_count: packageIds.length - completeItems.length,
    },
    root_installs: rootInstalls,
    items,
    failures,
    retryable: status !== 'completed',
    blocks_plain_codex: false,
  };
  return readback;
}

export async function reconcileBundledFullRuntimePackagesIfAvailable(
  env: NodeJS.ProcessEnv = process.env,
  options: FullRuntimePackageReconciliationOptions = {},
) {
  try {
    return await reconcileBundledFullRuntimePackages(env, options);
  } catch (error) {
    return {
      surface_kind: 'opl_full_runtime_package_reconciliation.v1' as const,
      status: 'failed' as 'failed' | 'incomplete',
      orchestration_policy: 'fail_open_per_root_package' as const,
      package_mutation_policy: 'package_local_atomic_root_retryable' as const,
      catalog_ref: null,
      catalog_sha256: null,
      root_package_ids: [] as string[],
      summary: {
        total: 0,
        installed: 0,
        already_installed: 0,
        installed_package_count: 0,
        materialized_package_count: 0,
        root_package_count: 0,
        failed_package_count: 1,
      },
      root_installs: [] as Array<Record<string, unknown>>,
      items: [] as Array<Record<string, unknown>>,
      failures: [failureReadback(error)],
      retryable: true,
      blocks_plain_codex: false,
    };
  }
}
