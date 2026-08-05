import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import { resolveOplStatePaths } from '../../../kernel/runtime-state-paths.ts';
import {
  readBundledFullRuntimePackageCatalog,
  resolveBundledFullRuntimePackageRoot,
  type BundledFullRuntimeCatalogEntry,
  type BundledFullRuntimePackageCatalog,
} from '../agent-package-registry-parts/bundled-full-runtime-catalog.ts';
import {
  runConfiguredCodexPluginCarrier,
  type ConfiguredCodexPluginCarrierReadback,
} from '../agent-package-registry-parts/configured-codex-plugin-carrier.ts';
import {
  readInstalledCarrierEntries,
  type InstalledCarrierEntry,
} from '../agent-package-registry-parts/installed-codex-plugin-directory.ts';
import { normalizePackageManifest } from '../agent-package-registry-parts/manifest-normalizers.ts';
import { resolveBundledFullRuntimeManifestPhysicalSource } from '../agent-package-registry-parts/physical-surface.ts';
import { safePathSegment } from '../agent-package-registry-parts/shared.ts';
import type {
  AgentPackageConfiguredCodexPluginCarrierDescriptor,
  AgentPackageManifest,
} from '../agent-package-registry-parts/types.ts';
import {
  materializeLocalCodexPluginMarketplaceRoute,
  resolveCanonicalOplFamilyMarketplaceId,
} from './codex-plugin-registry.ts';

type FullRuntimeOwnerSourceResolver = (input: {
  manifest: AgentPackageManifest;
  catalogEntry: BundledFullRuntimeCatalogEntry;
  packageRoot: string;
}) => AgentPackageManifest;

type FullRuntimePackageReconciliationOptions = {
  resolveOwnerSource?: FullRuntimeOwnerSourceResolver;
  materializeCarrierRoute?: typeof materializeLocalCodexPluginMarketplaceRoute;
  runConfiguredCarrier?: typeof runConfiguredCodexPluginCarrier;
  readCatalog?: () => BundledFullRuntimePackageCatalog;
  readInstalledCarrierEntries?: () => InstalledCarrierEntry[];
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

function catalogEntryCarriesOwnerDescriptor(entry: BundledFullRuntimeCatalogEntry) {
  const payload = parseJsonText(entry.payloadManifestJson);
  return isRecord(payload)
    && Array.isArray(payload.files)
    && payload.files.some((file) => isRecord(file) && file.path === 'opl-package.json');
}

function pluginBareName(pluginId: string) {
  return pluginId.split('@', 1)[0] ?? pluginId;
}

type NativeCarrierProjection = {
  status: 'owner_source_verified';
  package_id: string;
  plugin_id: string;
  codex_default_exposure: boolean;
  marketplace_id: string | null;
  marketplace_root: string | null;
  marketplace_path: string | null;
  marketplace_plugin_path: string | null;
  codex_plugin_cache_path: null;
  materialized_required_skill_ids: string[];
  materialized_required_skill_paths: string[];
  owner_source_path: string;
};
type CurrentProjection = {
  manifest: AgentPackageManifest;
  surface: NativeCarrierProjection | null;
  nativeCarrier: InstalledCarrierEntry | null;
  managedPolicy: {
    status: 'not_requested';
    reason: 'native_carrier_owner_source';
  } | null;
  error: unknown | null;
  carrierReadFailed: boolean;
};

function sameStrings(left: string[], right: string[]) {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.length === rightSorted.length
    && leftSorted.every((value, index) => value === rightSorted[index]);
}

function resolveVerifiedOwnerSource(input: {
  manifest: AgentPackageManifest;
  catalogEntry: BundledFullRuntimeCatalogEntry;
  packageRoot: string;
}) {
  const manifest = resolveBundledFullRuntimeManifestPhysicalSource(input);
  const sourcePath = fs.realpathSync.native(path.resolve(manifest.plugin_source_path!));
  const ownerManifestPath = path.join(sourcePath, 'opl-package.json');
  const ownerManifestStat = fs.lstatSync(ownerManifestPath);
  if (!ownerManifestStat.isFile() || ownerManifestStat.isSymbolicLink()) {
    fail('Bundled Full runtime owner descriptor is not a regular file.', {
      package_id: manifest.package_id,
      owner_manifest_path: ownerManifestPath,
      failure_code: 'full_runtime_package_owner_descriptor_invalid',
    });
  }
  const ownerManifest = normalizePackageManifest(
    parseJsonText(fs.readFileSync(ownerManifestPath, 'utf8')),
    pathToFileURL(ownerManifestPath).href,
  );
  if (
    ownerManifest.package_id !== manifest.package_id
    || ownerManifest.version !== manifest.version
    || ownerManifest.plugin_id !== manifest.plugin_id
    || ownerManifest.codex_default_exposure !== manifest.codex_default_exposure
    || !sameStrings(ownerManifest.required_skill_ids, manifest.required_skill_ids)
  ) {
    fail('Bundled Full runtime owner descriptor does not match the catalog identity.', {
      package_id: manifest.package_id,
      owner_manifest_path: ownerManifestPath,
      owner_package_id: ownerManifest.package_id,
      owner_version: ownerManifest.version,
      owner_plugin_id: ownerManifest.plugin_id,
      failure_code: 'full_runtime_package_owner_descriptor_mismatch',
    });
  }
  return { ...manifest, plugin_source_path: sourcePath };
}

function nativeRoute(manifest: AgentPackageManifest, stateDir: string) {
  const pluginId = manifest.plugin_id!;
  const marketplaceId = resolveCanonicalOplFamilyMarketplaceId(manifest.package_id, pluginId)
    ?? `opl-agent-${safePathSegment(manifest.package_id)}-local`;
  const marketplaceRoot = path.join(
    stateDir,
    'codex-plugin-marketplaces',
    marketplaceId,
  );
  return {
    marketplaceId,
    marketplaceRoot,
    marketplacePath: path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
  };
}

function configuredCarrierDescriptor(
  manifest: AgentPackageManifest,
  marketplaceId: string,
  marketplaceRoot: string,
): AgentPackageConfiguredCodexPluginCarrierDescriptor {
  return {
    packageId: manifest.package_id,
    carrier: {
      kind: 'codex_plugin_manager',
      pluginId: `${manifest.plugin_id!}@${marketplaceId}`,
      marketplaceSource: marketplaceRoot,
    },
    executor: {
      route: 'codex_cli',
      requiredSkillIds: [...manifest.required_skill_ids],
    },
    publicationRef: manifest.verified_payload_source_commit ?? null,
  };
}

function nativeCarrierSurface(
  manifest: AgentPackageManifest,
  stateDir: string,
): NativeCarrierProjection {
  const sourcePath = path.resolve(manifest.plugin_source_path!);
  const visible = manifest.codex_default_exposure !== false;
  const route = nativeRoute(manifest, stateDir);
  return {
    status: 'owner_source_verified',
    package_id: manifest.package_id,
    plugin_id: manifest.plugin_id!,
    codex_default_exposure: visible,
    marketplace_id: visible ? route.marketplaceId : null,
    marketplace_root: visible ? route.marketplaceRoot : null,
    marketplace_path: visible ? route.marketplacePath : null,
    marketplace_plugin_path: visible ? sourcePath : null,
    codex_plugin_cache_path: null,
    materialized_required_skill_ids: [...manifest.required_skill_ids],
    materialized_required_skill_paths: manifest.required_skill_ids.map((skillId) =>
      path.join(sourcePath, 'skills', skillId, 'SKILL.md')),
    owner_source_path: sourcePath,
  };
}

function assertNativeCarrierProjection(
  manifest: AgentPackageManifest,
  entries: InstalledCarrierEntry[],
  stateDir: string,
) {
  const pluginId = manifest.plugin_id!;
  const sourcePath = path.resolve(manifest.plugin_source_path!);
  const route = nativeRoute(manifest, stateDir);
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
  const expectedPluginId = `${pluginId}@${route.marketplaceId}`;
  if (
    matchingEntries.length !== 1
    || matchingEntries[0].pluginId !== expectedPluginId
    || matchingEntries[0].version !== manifest.version
    || !matchingEntries[0].enabled
    || path.resolve(matchingEntries[0].sourcePath) !== sourcePath
    || !matchingEntries[0].marketplaceSource
    || path.resolve(matchingEntries[0].marketplaceSource) !== path.resolve(route.marketplaceRoot)
  ) {
    fail('Bundled Full runtime Package native carrier projection is missing, disabled, ambiguous, or stale.', {
      package_id: manifest.package_id,
      plugin_id: pluginId,
      expected_plugin_id: expectedPluginId,
      expected_version: manifest.version,
      expected_source_path: sourcePath,
      expected_marketplace_source: route.marketplaceRoot,
      native_entries: matchingEntries,
      failure_code: 'full_runtime_package_projection_incomplete',
    });
  }
  return matchingEntries[0];
}

function assertConfiguredCarrierReadback(
  manifest: AgentPackageManifest,
  readback: ConfiguredCodexPluginCarrierReadback,
  stateDir: string,
) {
  const route = nativeRoute(manifest, stateDir);
  const expectedPluginId = `${manifest.plugin_id!}@${route.marketplaceId}`;
  if (
    readback.package_id !== manifest.package_id
    || readback.carrier.plugin_id !== expectedPluginId
    || readback.carrier.precedence !== 'exact_single_source'
    || readback.status !== 'installed'
    || readback.installed_version !== manifest.version
    || readback.enabled !== true
    || !readback.plugin_source_path
    || path.resolve(readback.plugin_source_path) !== path.resolve(manifest.plugin_source_path!)
    || readback.executor.status !== 'callable'
  ) {
    fail('Bundled Full runtime native carrier mutation returned stale or incomplete readback.', {
      package_id: manifest.package_id,
      expected_plugin_id: expectedPluginId,
      expected_version: manifest.version,
      expected_source_path: manifest.plugin_source_path,
      carrier_readback: readback,
      failure_code: 'full_runtime_package_projection_incomplete',
    });
  }
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
  const packageIds = [...catalog.entries.keys()];
  const roots = rootPackageIds(catalog);
  const resolvedRoots = resolvePackageRoots(catalog, env);
  const missingOwnerDescriptorPackageIds = packageIds.filter((packageId) =>
    !catalogEntryCarriesOwnerDescriptor(catalog.entries.get(packageId)!));
  if (missingOwnerDescriptorPackageIds.length > 0) {
    fail('Bundled Full runtime Packages require native owner descriptors before reconciliation.', {
      package_ids: missingOwnerDescriptorPackageIds,
      mutation_started: false,
      failure_code: 'configured_codex_plugin_carrier_owner_descriptor_missing',
    });
  }
  const stateDir = env.OPL_STATE_DIR?.trim()
    ? path.resolve(env.OPL_STATE_DIR)
    : resolveOplStatePaths({
        dataDir: env.OPL_DATA_DIR?.trim() || env.AIONUI_DATA_DIR?.trim() || null,
      }).state_dir;
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
  const resolveOwnerSource = options.resolveOwnerSource ?? resolveVerifiedOwnerSource;
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
        const ownerManifest = resolveOwnerSource({
          manifest,
          catalogEntry: catalog.entries.get(packageId)!,
          packageRoot: resolvedRoots.roots[packageId],
        });
        const nativeCarrier = assertNativeCarrierProjection(ownerManifest, carrierEntries, stateDir);
        return [packageId, {
          manifest: ownerManifest,
          surface: nativeCarrierSurface(ownerManifest, stateDir),
          nativeCarrier,
          managedPolicy: {
            status: 'not_requested',
            reason: 'native_carrier_owner_source',
          },
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
  const materializeCarrierRoute = options.materializeCarrierRoute
    ?? materializeLocalCodexPluginMarketplaceRoute;
  const runConfiguredCarrier = options.runConfiguredCarrier ?? runConfiguredCodexPluginCarrier;
  const rootClosures = new Map(roots.map((packageId) => [packageId, catalogClosure(catalog, packageId)]));

  for (const packageId of roots) {
    const closure = rootClosures.get(packageId)!;
    if (closure.every(isCurrent)) {
      rootInstalls.push({
        target_id: packageId,
        package_id: packageId,
        status: 'skipped',
        reason: 'catalog_identity_and_native_carrier_closure_current',
        action: null,
        result: null,
        ...rootTargetIdentity(catalog, packageId),
        dependency_transaction_id: null,
        dependency_package_ids: closure,
      });
      continue;
    }
    const completedPackageIds: string[] = [];
    const mutationStartedPackageIds: string[] = [];
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
      const pendingPackageIds = closure.filter((closurePackageId) => !isCurrent(closurePackageId));
      const ownerManifests = new Map(pendingPackageIds.map((closurePackageId) => [
        closurePackageId,
        resolveOwnerSource({
          manifest: manifests.get(closurePackageId)!,
          catalogEntry: catalog.entries.get(closurePackageId)!,
          packageRoot: resolvedRoots.roots[closurePackageId],
        }),
      ]));
      const carrierActions: Array<Record<string, unknown>> = [];
      for (const closurePackageId of pendingPackageIds) {
        const ownerManifest = ownerManifests.get(closurePackageId)!;
        if (ownerManifest.codex_default_exposure === false) {
          throw currentProjection.get(closurePackageId)?.error
            ?? new FrameworkContractError(
              'contract_shape_invalid',
              'Hidden bundled Full runtime Package cannot be repaired through a global carrier mutation.',
              {
                package_id: closurePackageId,
                mutation_started: false,
                failure_code: 'full_runtime_package_hidden_carrier_exposure',
              },
            );
        }
        const route = nativeRoute(ownerManifest, stateDir);
        const marketplace = materializeCarrierRoute({
          marketplace_id: route.marketplaceId,
          plugin_id: ownerManifest.plugin_id!,
          display_name: ownerManifest.display_name,
          category: 'OPL Packages',
        }, ownerManifest.plugin_source_path!, route.marketplaceRoot);
        mutationStartedPackageIds.push(closurePackageId);
        const carrier = runConfiguredCarrier({
          descriptor: configuredCarrierDescriptor(
            ownerManifest,
            route.marketplaceId,
            route.marketplaceRoot,
          ),
          action: lifecycleAction,
          binary: env.OPL_CODEX_PLUGIN_BIN,
          env,
        });
        assertConfiguredCarrierReadback(ownerManifest, carrier, stateDir);
        completedPackageIds.push(closurePackageId);
        touchedPackageIds.add(closurePackageId);
        carrierActions.push({
          package_id: closurePackageId,
          status: carrier.status,
          operation: carrier.operation,
          native_action_dispatched: carrier.native_action_dispatched,
          marketplace_path: marketplace.marketplace_path,
          plugin_source_path: carrier.plugin_source_path,
        });
      }
      verifyCurrentClosure(packageId, closure);
      rootInstalls.push({
        target_id: packageId,
        package_id: packageId,
        status: 'completed',
        reason: 'native_carrier_reconciliation_completed',
        action: lifecycleAction,
        result: {
          surface_kind: 'opl_full_runtime_native_carrier_reconciliation.v1',
          status: 'completed',
          package_carrier_actions: carrierActions,
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
      const failure = {
        ...initialFailure,
        details: {
          ...initialFailureDetails,
          completed_package_ids: completedPackageIds,
          mutation_started_package_ids: mutationStartedPackageIds,
          mutation_started: mutationStartedPackageIds.length > 0
            ? true
            : initialFailureDetails.mutation_started === false
              ? false
              : null,
          package_mutation_status: mutationStartedPackageIds.length > 0
            ? 'partially_applied_native_carrier_retryable'
            : initialFailureDetails.package_mutation_status
              ?? 'not_started_or_package_local_rollback',
          local_prestate_restored: null,
        },
      };
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
          : 'package_mutation_unit_failed_retryable',
        action: lifecycleAction,
        result: {
          failure,
          package_mutation_unit: {
            scope: 'package_local_native_carrier_with_root_retry',
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
    package_mutation_policy: 'package_local_native_carrier_root_retryable' as const,
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
      package_mutation_policy: 'package_local_native_carrier_root_retryable' as const,
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
