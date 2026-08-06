import path from 'node:path';

import { FrameworkContractError } from '../../../kernel/contract-validation.ts';
import { resolveOplStatePaths } from '../../../kernel/runtime-state-paths.ts';
import { canonicalAgentPackageId } from '../agent-package-identity.ts';
import { unregisterLocalCodexPlugin } from '../system-installation/codex-plugin-registry.ts';
import { removeSafePersistedPackagePath } from './persisted-path-safety.ts';
import {
  resolveCodexConfigPath,
  resolveCodexHome,
  sha256Text,
} from './shared.ts';
import type {
  AgentPackageCarrierAuthority,
  AgentPackageLifecycleAction,
  AgentPackageLock,
  AgentPackageManifest,
  AgentPackagePhysicalSurface,
  AgentPackageResolvedDependency,
  AgentPackageManagedRuntimeSourceState,
  AgentPackageScopeMaterialization,
  AgentPackageSourceKind,
} from './types.ts';

export function packageLockRef(packageId: string, version: string, sourceSha256: string) {
  const canonicalPackageId = canonicalAgentPackageId(packageId) ?? packageId;
  return `opl://agent-package-lock/${encodeURIComponent(canonicalPackageId)}/${encodeURIComponent(version)}/${sourceSha256.slice(0, 16)}`;
}

export function packageActionStatus(action: AgentPackageLifecycleAction) {
  return {
    install: 'installed',
    update: 'updated',
    repair: 'repaired',
    activate: 'activated',
    uninstall: 'uninstalled',
    hide: 'hidden',
    unhide: 'visible',
    enable: 'enabled',
    disable: 'disabled',
  }[action];
}

export function requirePackageId(packageId: string | null | undefined, action: string) {
  const normalized = canonicalAgentPackageId(packageId);
  if (!normalized) {
    throw new FrameworkContractError('cli_usage_error', `Agent package ${action} requires --package-id.`, {
      required: ['--package-id'],
      action,
    });
  }
  return normalized;
}

export function permissionScopeSha256(manifest: AgentPackageManifest) {
  return sha256Text(JSON.stringify({
    codex_default_exposure: manifest.codex_default_exposure === false ? false : undefined,
    codex_visible_entry: manifest.codex_visible_entry,
    entrypoints: manifest.entrypoints,
    permissions: manifest.permissions,
    runtime_source_carrier: manifest.runtime_source_carrier,
  }));
}

export function buildLock(input: {
  manifest: AgentPackageManifest;
  manifestUrl: string;
  manifestSha256: string;
  sourceKind: AgentPackageSourceKind;
  trustTier: string;
  physicalSurface: AgentPackagePhysicalSurface;
  previousLock?: AgentPackageLock | null;
  resolvedDependencies?: AgentPackageResolvedDependency[];
  dependencyClosureDigest?: string;
  dependencyTransactionId?: string;
  scopeMaterialization?: AgentPackageScopeMaterialization | null;
  managedRuntimeSource?: AgentPackageManagedRuntimeSourceState | null;
  sourceArtifactRef?: string | null;
  artifactDigest?: string | null;
  packageContentDigest?: string | null;
  ownerSourceCommit?: string | null;
  carrierAuthority?: AgentPackageCarrierAuthority | null;
  releaseChannelRef?: string | null;
  releaseChannelDigest?: string | null;
}): AgentPackageLock {
  const exposureState = input.manifest.codex_default_exposure === false
    ? 'hidden' as const
    : input.previousLock?.exposure_state ?? 'visible';
  return {
    surface_kind: 'opl_agent_package_lock',
    package_id: input.manifest.package_id,
    agent_id: input.manifest.agent_id,
    package_role: input.manifest.package_role,
    display_name: input.manifest.display_name,
    publisher: input.manifest.publisher,
    package_version: input.manifest.version,
    owner_language_version: input.manifest.owner_language_version,
    codex_visible_entry: input.manifest.codex_visible_entry,
    bundled_required_skill_ids: input.manifest.required_skill_ids,
    optional_skill_refs: input.manifest.optional_skill_refs,
    source_kind: input.sourceKind,
    trust_tier: input.trustTier,
    manifest_url: input.manifestUrl,
    manifest_sha256: input.manifestSha256,
    source_artifact_ref: input.sourceArtifactRef ?? null,
    artifact_digest: input.artifactDigest ?? null,
    owner_source_commit: input.ownerSourceCommit ?? null,
    carrier_authority: input.carrierAuthority ?? null,
    release_channel_ref: input.releaseChannelRef ?? null,
    release_channel_digest: input.releaseChannelDigest ?? null,
    permission_scope_sha256: permissionScopeSha256(input.manifest),
    lock_ref: packageLockRef(input.manifest.package_id, input.manifest.version, input.manifestSha256),
    physical_surface: input.physicalSurface,
    exposure_state: exposureState,
    capability_provider: input.manifest.capability_provider,
    capability_dependencies: input.manifest.capability_dependencies,
    resolved_dependencies: input.resolvedDependencies ?? [],
    dependency_closure_digest: input.dependencyClosureDigest ?? '',
    dependency_transaction_id: input.dependencyTransactionId ?? '',
    content_digest: input.manifest.content_digest
      ?? input.manifest.distribution_payload?.payload_digest_ref
      ?? `sha256:${input.manifestSha256}`,
    content_lock_canonicalization: input.manifest.content_lock_canonicalization,
    content_lock_paths: input.manifest.content_lock_paths,
    package_content_digest: input.packageContentDigest
      ?? input.previousLock?.package_content_digest
      ?? null,
    scope_materializations: input.scopeMaterialization
      ? [
          input.scopeMaterialization,
          ...(input.previousLock?.scope_materializations ?? []).filter((entry) =>
            entry.scope !== input.scopeMaterialization!.scope
            || entry.target_root !== input.scopeMaterialization!.target_root),
        ]
      : input.previousLock?.scope_materializations ?? [],
    runtime_source_carrier: input.manifest.runtime_source_carrier,
    managed_runtime_source: input.managedRuntimeSource ?? null,
    managed_update_source: input.manifest.managed_update_source,
    developer_checkout_source: input.manifest.developer_checkout_source ?? null,
  };
}

export function cleanupPreviousPhysicalSurface(
  previous: AgentPackagePhysicalSurface | undefined,
  current: AgentPackagePhysicalSurface,
  options: { retainPayloadSource?: boolean; retainedPaths?: ReadonlySet<string> } = {},
) {
  if (!previous || previous.status === 'not_requested') {
    return;
  }

  if (
    previous.plugin_id
    && previous.marketplace_id
    && (previous.plugin_id !== current.plugin_id || previous.marketplace_id !== current.marketplace_id)
  ) {
    const expectedConfigPath = resolveCodexConfigPath(resolveCodexHome());
    if (path.resolve(previous.codex_config_path) !== path.resolve(expectedConfigPath)) {
      throw new FrameworkContractError('contract_shape_invalid', 'Persisted package Codex config path does not match the active Codex home.', {
        codex_config_path: previous.codex_config_path,
        expected_codex_config_path: expectedConfigPath,
        failure_code: 'agent_package_persisted_path_unsafe',
      });
    }
    unregisterLocalCodexPlugin(previous.codex_config_path, previous.marketplace_id, previous.plugin_id);
  }

  const removals = [
    previous.codex_plugin_cache_path ? {
      path: previous.codex_plugin_cache_path,
      root: path.join(resolveCodexHome(), 'plugins', 'cache'),
      kind: 'previous_physical_surface.codex_plugin_cache_path',
    } : null,
    previous.marketplace_plugin_path ? {
      path: previous.marketplace_plugin_path,
      root: path.join(resolveOplStatePaths().state_dir, 'codex-plugin-marketplaces'),
      kind: 'previous_physical_surface.marketplace_plugin_path',
    } : null,
    !options.retainPayloadSource && previous.plugin_payload_cache_path ? {
      path: previous.plugin_payload_cache_path,
      root: path.join(resolveOplStatePaths().state_dir, 'agent-package-payloads'),
      kind: 'previous_physical_surface.plugin_payload_cache_path',
    } : null,
  ].flatMap((entry) => entry ? [entry] : []);
  for (const removal of removals) {
    const oldPath = removal.path;
    if (
      !options.retainedPaths?.has(oldPath)
      && oldPath !== current.codex_plugin_cache_path
      && oldPath !== current.marketplace_plugin_path
      && oldPath !== current.plugin_payload_cache_path
    ) {
      removeSafePersistedPackagePath({
        candidatePath: oldPath,
        allowedRoots: [removal.root],
        pathKind: removal.kind,
        recursive: true,
      });
    }
  }
}
