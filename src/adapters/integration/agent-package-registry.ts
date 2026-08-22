import fs from 'node:fs';
import path from 'node:path';

import { deriveAgentPackageLaunchState } from '../../kernel/agent-package-launch-state.ts';
import { FrameworkContractError } from '../../kernel/contract-validation.ts';
import { parseJsonText } from '../../kernel/json-file.ts';
import { refsOnlyAuthorityBoundary } from '../../kernel/refs-only-authority-boundary.ts';
import { resolveOplStatePaths } from '../../kernel/runtime-state-paths.ts';
import { canonicalAgentPackageId } from './agent-package-identity.ts';
import { isFirstPartyPackage } from './agent-package-first-party.ts';
import { listAgentPackageSettingsActions } from './agent-package-actions.ts';
import {
  discoverAvailablePackageDescriptors,
  discoverInstalledPackageDescriptors,
  discoverInstalledOwnerProfileDescriptors,
  installedDescriptorMatchesConfiguredCarrier,
  type InstalledPackageDescriptor,
} from './agent-package-registry-parts/installed-codex-plugin-directory.ts';
import {
  mergedHomeShortcutPreferences,
  updateHomeShortcutPreferences,
  withHomeShortcutPreferenceTransaction,
} from './agent-package-registry-parts/home-shortcuts.ts';
import {
  runConfiguredCodexPluginCarrier,
  sourceTreeSha256,
  type ConfiguredCodexPluginCarrierAction,
  type ConfiguredCodexPluginCarrierReadback,
} from './agent-package-registry-parts/configured-codex-plugin-carrier.ts';
import {
  managedPolicyDependenciesFromDescriptor,
  managedPolicyCurrentnessFromDescriptor,
  repairManagedPolicyDependenciesFromDescriptor,
} from './agent-package-registry-parts/managed-policy-surface.ts';
import { normalizePackageManifest } from './agent-package-registry-parts/manifest-normalizers.ts';
import { sha256Text } from './agent-package-registry-parts/shared.ts';
import { materializeStandardAgentFrameworkLink } from './standard-agent-framework-link.ts';
import type {
  AgentPackageHomeShortcutPreferencesSetInput,
  AgentPackageInstallInput,
  AgentPackageManagedPolicyDependency,
  AgentPackagePackageActionInput,
  AgentPackageRepairInput,
} from './agent-package-registry-parts/types.ts';

export type {
  AgentPackageHomeShortcutPreferencesSetInput,
  AgentPackageInstallInput,
  AgentPackagePackageActionInput,
  AgentPackageRepairInput,
} from './agent-package-registry-parts/types.ts';

export type OplAgentPackageStatusInput = {
  packageId?: string | null;
  detail?: 'fast' | 'full';
};

type PackageSnapshot = {
  descriptors: Map<string, InstalledPackageDescriptor>;
  installed: Map<string, InstalledPackageDescriptor>;
};

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function packageSnapshot(input: { includeAvailable?: boolean } = {}): PackageSnapshot {
  const discoveredInstalled = discoverInstalledPackageDescriptors();
  const installed = new Map(
    [...discoveredInstalled].filter(([, descriptor]) => (
      installedDescriptorMatchesConfiguredCarrier(descriptor)
    )),
  );
  const descriptors = input.includeAvailable
    ? discoverAvailablePackageDescriptors()
    : new Map<string, InstalledPackageDescriptor>();
  for (const [packageId, descriptor] of discoveredInstalled) descriptors.set(packageId, descriptor);
  return {
    descriptors,
    installed,
  };
}

function requirePackageId(value: string | null | undefined, action: string) {
  const packageId = canonicalAgentPackageId(value);
  if (!packageId) {
    throw new FrameworkContractError('cli_usage_error', `${action} requires a Package id.`, {
      action,
      failure_code: 'agent_package_id_required',
    });
  }
  return packageId;
}

function assertManualManifestUrl(value: string | null | undefined) {
  const source = stringValue(value);
  if (!source) {
    throw new FrameworkContractError('cli_usage_error', 'Manual Agent installation requires a manifest URL.', {
      action_id: 'install_from_manifest_url',
      required: ['manifest_url'],
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new FrameworkContractError('cli_usage_error', 'Agent manifest URL is invalid.', {
      action_id: 'install_from_manifest_url',
      manifest_url: source,
    });
  }
  const loopbackHttp = parsed.protocol === 'http:'
    && ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'file:' && !loopbackHttp) {
    throw new FrameworkContractError('cli_usage_error', 'Agent manifest URL must use HTTPS, file, or loopback HTTP.', {
      action_id: 'install_from_manifest_url',
      manifest_url: source,
      allowed_protocols: ['https', 'file', 'loopback_http'],
    });
  }
  return parsed;
}

async function readManualAgentManifest(input: AgentPackageInstallInput) {
  const source = assertManualManifestUrl(input.manifestUrl);
  if (input.trustTier !== 'third_party_unverified' && input.trustTier !== 'third_party_verified') {
    throw new FrameworkContractError('cli_usage_error', 'Manual Agent installation requires an explicit third-party trust tier.', {
      action_id: 'install_from_manifest_url',
      required: ['trust_tier'],
      allowed_trust_tiers: ['third_party_unverified', 'third_party_verified'],
    });
  }
  let raw: string;
  if (source.protocol === 'file:') {
    raw = fs.readFileSync(source, 'utf8');
  } else {
    const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new FrameworkContractError('codex_command_failed', 'Agent manifest fetch failed.', {
        manifest_url: source.toString(),
        status: response.status,
      });
    }
    raw = await response.text();
  }
  let manifest;
  try {
    manifest = normalizePackageManifest(parseJsonText(raw), source.toString());
  } catch (error) {
    if (error instanceof FrameworkContractError) throw error;
    throw new FrameworkContractError('contract_json_invalid', 'Agent manifest must be valid JSON.', {
      manifest_url: source.toString(),
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (manifest.package_role !== 'standard_agent' && manifest.package_role !== 'workflow_profile') {
    throw new FrameworkContractError('contract_shape_invalid', 'The Add Agent flow accepts Agent or workflow Packages only.', {
      manifest_url: source.toString(),
      package_id: manifest.package_id,
      package_role: manifest.package_role,
      allowed_package_roles: ['standard_agent', 'workflow_profile'],
    });
  }
  if (isFirstPartyPackage(manifest.package_id)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Manual manifests cannot claim an OPL-managed Package identity.', {
      manifest_url: source.toString(),
      package_id: manifest.package_id,
      failure_code: 'manual_manifest_first_party_identity_forbidden',
    });
  }
  if (!manifest.configured_codex_plugin_carrier) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent manifest must declare a configured Codex Plugin carrier.', {
      manifest_url: source.toString(),
      package_id: manifest.package_id,
      failure_code: 'manual_manifest_native_carrier_missing',
    });
  }
  return { manifest, source: source.toString(), raw };
}

function requireDescriptor(
  input: Pick<AgentPackageInstallInput, 'packageId'>,
  action: string,
  options: { installed?: boolean } = {},
) {
  const packageId = requirePackageId(input.packageId, action);
  const snapshot = packageSnapshot({ includeAvailable: options.installed !== true });
  const descriptor = (options.installed ? snapshot.installed : snapshot.descriptors).get(packageId) ?? null;
  if (!descriptor) {
    throw new FrameworkContractError('contract_shape_invalid', `Package ${packageId} is not exposed by a native carrier.`, {
      package_id: packageId,
      action,
      failure_code: options.installed
        ? 'agent_package_not_installed'
        : 'agent_package_native_descriptor_unavailable',
    });
  }
  return descriptor;
}

function configuredCarrierFromDescriptor(
  descriptor: InstalledPackageDescriptor,
  operation: ConfiguredCodexPluginCarrierAction = 'list',
): ConfiguredCodexPluginCarrierReadback {
  const expectedCarrier = descriptor.carrier.carrier;
  const exactCarrier = installedDescriptorMatchesConfiguredCarrier(descriptor);
  const installed = descriptor.readiness.installed && exactCarrier;
  const physical = descriptor.readiness.physical_status === 'available';
  const callable = installed && physical && descriptor.readiness.callability === 'callable';
  const observedBase = descriptor.pluginId.split('@', 1)[0];
  const expectedBase = expectedCarrier.pluginId.split('@', 1)[0];
  return {
    surface_kind: 'opl_configured_codex_plugin_carrier_readback.v1',
    package_id: descriptor.manifest.package_id,
    carrier: {
      kind: 'codex_plugin_manager',
      plugin_id: expectedCarrier.pluginId,
      marketplace_source: expectedCarrier.marketplaceSource,
      observed_sources: [{
        plugin_id: descriptor.pluginId,
        marketplace_source: descriptor.marketplaceSource,
        installed_version: installed ? descriptor.carrier_readback.version : null,
        enabled: installed && descriptor.enabled,
        plugin_source_path: descriptor.sourcePath,
        source_tree_sha256: sourceTreeSha256(descriptor.sourcePath),
      }],
      precedence: installed
        ? 'exact_single_source'
        : descriptor.readiness.installed && observedBase === expectedBase
          ? 'unexpected_same_plugin_name'
          : 'not_present',
    },
    executor: {
      route: 'codex_cli',
      required_skill_ids: [...descriptor.manifest.required_skill_ids],
      status: callable ? 'callable' : 'attention_needed',
    },
    publication_ref: descriptor.carrier.publicationRef,
    status: installed ? (physical ? 'installed' : 'physical_unavailable') : 'not_installed',
    installed_version: installed ? descriptor.carrier_readback.version : null,
    enabled: installed ? descriptor.enabled : null,
    plugin_source_path: installed ? descriptor.sourcePath : null,
    operation,
    native_command: installed
      ? ['plugin', 'list', '--json']
      : ['plugin', 'list', '--available', '--json'],
    native_action_dispatched: operation === 'list',
    reason: callable
      ? null
      : !exactCarrier
        ? 'configured_native_carrier_unexpected_source_present'
        : !installed
          ? 'configured_native_carrier_not_installed'
        : !physical
          ? 'configured_native_carrier_physical_unavailable'
          : 'configured_native_carrier_disabled',
  };
}

function dependencyReadiness(
  descriptor: InstalledPackageDescriptor | null,
  installed: ReadonlyMap<string, InstalledPackageDescriptor>,
) {
  if (!descriptor) return null;
  const dependencies = descriptor.manifest.capability_dependencies.map((dependency) => {
    const candidate = installed.get(dependency.package_id) ?? null;
    const present = candidate?.readiness.installed === true;
    const callable = present
      && candidate?.readiness.physical_status === 'available'
      && (candidate.readiness.callability === 'callable'
        || candidate.readiness.projection_callability === 'callable');
    const reasons = !present
      ? ['package_missing']
      : callable
        ? []
        : [candidate?.readiness.physical_status !== 'available'
            ? 'package_source_unavailable'
            : 'package_disabled'];
    return {
      package_id: dependency.package_id,
      required: dependency.required,
      consumer_profile_id: dependency.consumer_profile_id ?? null,
      required_export_ids: [...dependency.required_export_ids],
      required_module_ids: [...dependency.required_module_ids],
      installed_version: candidate?.manifest.version ?? null,
      manifest_sha256: candidate?.manifest_sha256 ?? null,
      content_digest: candidate?.manifest.content_digest ?? null,
      status: !present ? 'missing' as const : callable ? 'current' as const : 'incompatible' as const,
      reasons,
      missing_required_export_ids: [],
      missing_required_module_ids: [],
    };
  });
  const required = dependencies.filter((dependency) => dependency.required);
  const operational = required.every((dependency) => dependency.status === 'current');
  return {
    status: operational ? 'current' as const : required.some((dependency) => dependency.status === 'missing')
      ? 'missing' as const
      : 'incompatible' as const,
    operational_ready: operational,
    dependencies,
  };
}

function presentationText(value: Record<string, string> | null | undefined, fallback: string) {
  return value?.['en-US'] ?? value?.zh ?? Object.values(value ?? {})[0] ?? fallback;
}

type AgentPackageSettingsAction = ReturnType<typeof listAgentPackageSettingsActions>[number];

function projectDirectoryAction(action: AgentPackageSettingsAction, packageId: string) {
  // Update and preferences are configure/install catalog entries whose directory semantics are more specific.
  const semantic = action.action_id === 'agent_package_update'
    ? 'update' as const
    : action.action_id === 'agent_package_preferences_set'
      ? 'preferences' as const
      : action.task_kind;
  return {
    action_id: action.action_id,
    action_ref: `app_state.actions#${action.action_id}`,
    payload: { package_id: packageId },
    required_payload_fields: action.action_id === 'agent_package_preferences_set'
      ? ['package_id', 'exposure_action or shortcut_id']
      : ['package_id'],
    confirmation_required: action.confirmation_required,
    semantic,
    surface: 'settings' as const,
  };
}

function actionEntries(installed: boolean, packageId: string) {
  return listAgentPackageSettingsActions()
    .filter((action) => action.action_id !== 'install_from_manifest_url')
    .filter((action) => installed
      ? action.action_id !== 'agent_package_install'
      : action.action_id === 'agent_package_install')
    .map((action) => projectDirectoryAction(action, packageId));
}

function directoryEntry(descriptor: InstalledPackageDescriptor) {
  const manifest = descriptor.manifest;
  const installed = descriptor.readiness.installed
    && installedDescriptorMatchesConfiguredCarrier(descriptor);
  const ready = installed
    && descriptor.readiness.physical_status === 'available'
    && descriptor.readiness.callability === 'callable';
  const actions = actionEntries(installed, manifest.package_id);
  const recommendedAction = installed ? (ready ? null : 'agent_package_repair') : 'agent_package_install';
  return {
    package_id: manifest.package_id,
    display_name: manifest.display_name,
    publisher: manifest.publisher,
    description: presentationText(manifest.presentation?.description_i18n, manifest.display_name),
    tags: [],
    package_role: manifest.package_role,
    capability_metadata: null,
    display_name_i18n: manifest.presentation?.display_name_i18n ?? null,
    description_i18n: manifest.presentation?.description_i18n ?? null,
    session_routing_summary_i18n: manifest.presentation?.session_routing_summary_i18n ?? null,
    home_shortcuts: manifest.presentation?.home_shortcuts ?? [],
    home_shortcut_ids: manifest.presentation?.home_shortcuts.map((shortcut) => shortcut.shortcut_id) ?? [],
    app_contributions: manifest.app_contributions ?? null,
    capability_dependency_summary: {
      total_count: manifest.capability_dependencies.length,
      required_count: manifest.capability_dependencies.filter((dependency) => dependency.required).length,
    },
    configured_carrier: configuredCarrierFromDescriptor(descriptor),
    installed_carrier_readback: installed ? descriptor.carrier_readback : null,
    installed_readiness: installed ? descriptor.readiness : null,
    role_state: {
      status: 'current' as const,
      source: 'native_carrier_descriptor' as const,
      discovered_role: manifest.package_role,
      installed_role: installed ? manifest.package_role : null,
      diagnostic: null,
    },
    installed,
    activated: ready,
    installability: {
      status: installed ? 'installed' as const : 'installable' as const,
      installable: !installed,
    },
    readiness: {
      status: !installed ? 'not_installed' as const : ready ? 'ready' as const : 'attention_needed' as const,
      operational_ready: ready,
      launch_allowed: ready,
      verification_deferred: false,
      reason: ready ? null : !installed ? 'package_not_installed' : 'native_carrier_not_callable',
      detail_surface: `opl packages status --package-id ${manifest.package_id} --json`,
      status_read_error: null,
    },
    recommended_action: recommendedAction,
    recommended_action_ref: recommendedAction
      ? actions.find((action) => action.action_id === recommendedAction) ?? null
      : null,
    available_actions: actions,
    authority_boundary: refsOnlyAuthorityBoundary(),
  };
}

function directoryFrom(snapshot: PackageSnapshot, detail: 'fast' | 'full') {
  const entries = [...snapshot.descriptors.values()]
    .map(directoryEntry)
    .sort((left, right) => left.display_name.localeCompare(right.display_name, 'en'));
  return {
    surface_kind: 'opl_agent_package_directory.v1' as const,
    status: 'available' as const,
    source_catalog_kind: 'native_carrier_descriptors' as const,
    detail,
    entry_count: entries.length,
    installed_package_count: entries.filter((entry) => entry.installed).length,
    installable_package_count: entries.filter((entry) => entry.installability.installable).length,
    entries,
    authority_boundary: refsOnlyAuthorityBoundary(),
  };
}

function buildPackageStatus(input: OplAgentPackageStatusInput, snapshot: PackageSnapshot) {
  const packageId = canonicalAgentPackageId(input.packageId);
  const descriptor = packageId ? snapshot.descriptors.get(packageId) ?? null : null;
  const installedDescriptor = packageId ? snapshot.installed.get(packageId) ?? null : null;
  const configuredCarrier = descriptor ? configuredCarrierFromDescriptor(descriptor) : null;
  const installedEntries = [...snapshot.installed.values()];
  const installed = packageId
    ? installedDescriptor?.readiness.installed === true
    : installedEntries.length > 0;
  const physical = packageId
    ? installedDescriptor?.readiness.physical_status === 'available'
    : installedEntries.length > 0 && installedEntries.every(
      (entry) => entry.readiness.physical_status === 'available',
    );
  const callable = packageId
    ? physical && installedDescriptor?.readiness.callability === 'callable'
    : physical && installedEntries.every((entry) => entry.readiness.callability === 'callable');
  const dependencies = dependencyReadiness(installedDescriptor, snapshot.installed);
  const dependenciesReady = packageId ? dependencies?.operational_ready !== false : true;
  const managedPolicyCurrentness = installedDescriptor
    ? managedPolicyCurrentnessFromDescriptor({
        manifest: {
          package_id: installedDescriptor.manifest.package_id,
          version: installedDescriptor.manifest.version,
          plugin_id: installedDescriptor.pluginId.split('@', 1)[0] ?? null,
          required_skill_ids: installedDescriptor.manifest.required_skill_ids,
          managed_policy_surface: installedDescriptor.manifest.managed_policy_surface,
        },
        sourceRoot: installedDescriptor.sourcePath,
        activeCarrierIdentity: installedDescriptor.carrier_readback.identity,
        detail: input.detail === 'fast' ? 'fast' : 'full',
      })
    : {
        surface_kind: 'opl_package_managed_policy_currentness' as const,
        status: 'not_requested' as const,
        policy_kind: null,
        policy_path: null,
        schema_path: null,
        expected_policy_sha256: null,
        actual_policy_sha256: null,
        inventory_digest: null,
        enabled_migration_ids: [],
        detected_conflicts: [],
        dependency_sync: null,
        required_dependencies_operational: true,
        required_dependency_failure_ids: [],
        model_projection: null,
        capability_strategy: null,
        repair_command: null,
        reason: 'Package does not expose an installed managed policy descriptor.',
      };
  const requiredPolicyDependenciesOperational = managedPolicyCurrentness.required_dependencies_operational !== false;
  const managedPolicyOperational = (
    managedPolicyCurrentness.status === 'current'
      || managedPolicyCurrentness.status === 'not_requested'
      || managedPolicyCurrentness.status === 'drifted'
  ) && requiredPolicyDependenciesOperational;
  const operationalReady = Boolean(
    installed && callable && dependenciesReady && managedPolicyOperational,
  );
  const launchBlockedReason = operationalReady
    ? null
    : packageId
        ? !descriptor
          ? 'native_carrier_descriptor_unavailable'
        : !installed
          ? configuredCarrier?.reason ?? 'package_not_installed'
          : !physical
            ? 'carrier_source_unavailable'
            : !callable
              ? 'carrier_disabled'
              : !requiredPolicyDependenciesOperational
                ? 'managed_policy_required_dependency_unavailable'
              : !managedPolicyOperational
                ? `managed_policy_${managedPolicyCurrentness.status}`
              : `package_dependency_${dependencies?.status ?? 'unavailable'}`
      : 'package_not_installed';
  const unavailableReason = !requiredPolicyDependenciesOperational
    ? 'managed_policy_required_dependency_unavailable'
    : managedPolicyCurrentness.status === 'invalid'
      ? 'managed_policy_invalid'
      : null;
  const degradedReason = unavailableReason
    ? null
    : managedPolicyCurrentness.experience_baseline?.status === 'degraded'
      ? 'experience_baseline_degraded'
      : managedPolicyCurrentness.status === 'drifted'
        ? 'managed_policy_drifted'
        : null;
  const launchState = deriveAgentPackageLaunchState({
    installed,
    exposure_state: installed ? (installedDescriptor?.enabled ? 'visible' : 'hidden') : 'not_installed',
    operational_ready: operationalReady,
    launch_blocked_reason: launchBlockedReason,
    degraded_reason: degradedReason,
    unavailable_reason: unavailableReason,
  });
  const homeShortcutPreferences = mergedHomeShortcutPreferences({
    entries: descriptor
      ? [directoryEntry(descriptor)]
      : [...snapshot.descriptors.values()].map(directoryEntry),
  }).filter((entry) => !packageId || entry.package_id === packageId);
  return {
    version: 'g2' as const,
    opl_agent_package_status: {
      surface_kind: 'opl_agent_package_status' as const,
      status: operationalReady ? 'available' : installed ? 'attention_needed' : 'not_installed',
      package_id: packageId ?? null,
      agent_id: installedDescriptor?.manifest.agent_id ?? descriptor?.manifest.agent_id ?? null,
      app_contributions: installedDescriptor?.manifest.app_contributions ?? null,
      installed_package_count: packageId ? (installed ? 1 : 0) : snapshot.installed.size,
      configured_carrier: configuredCarrier,
      installed_carrier_readback: installedDescriptor?.carrier_readback ?? null,
      installed_readiness: installedDescriptor?.readiness ?? descriptor?.readiness ?? null,
      installed_manifest_sha256: installedDescriptor?.manifest_sha256 ?? null,
      installed_content_digest: installedDescriptor?.manifest.content_digest ?? null,
      managed_policy_currentness: managedPolicyCurrentness,
      codex_visible: packageId
        ? Boolean(installed && installedDescriptor?.enabled)
        : installedEntries.some((entry) => entry.enabled),
      package_dependency_readiness: dependencies,
      package_operational: {
        status: operationalReady ? 'operational' as const : 'unavailable' as const,
        operational_ready: operationalReady,
        failure_reason: launchBlockedReason,
        repair_command: operationalReady
          ? null
          : !managedPolicyOperational
            ? managedPolicyCurrentness.repair_command
            : descriptor ? `codex plugin add ${descriptor.carrier.carrier.pluginId}` : null,
      },
      experience_baseline: managedPolicyCurrentness.experience_baseline ?? {
        status: 'not_declared' as const,
        failure_ids: [],
        repair_command: null,
        capabilities: [],
      },
      specialized_capabilities: managedPolicyCurrentness.specialized_capabilities ?? {
        status: 'not_declared' as const,
        repair_command: null,
        capabilities: [],
      },
      model_projection: managedPolicyCurrentness.model_projection,
      capability_strategy: managedPolicyCurrentness.capability_strategy,
      operational_ready: operationalReady,
      operational_ready_scope: installedDescriptor?.manifest.managed_policy_surface
        ? 'installed_carrier_presence_callability_dependency_closure_and_managed_policy' as const
        : 'installed_carrier_presence_callability_dependency_closure' as const,
      launch_allowed: operationalReady,
      launch_blocked_reason: launchBlockedReason,
      ...launchState,
      allowed_when_blocked: ['status', 'repair'],
      repair_action: !managedPolicyOperational
        ? managedPolicyCurrentness.repair_command
        : descriptor ? `codex plugin add ${descriptor.carrier.carrier.pluginId}` : null,
      home_shortcut_preferences: homeShortcutPreferences,
      files: {
        home_shortcut_preferences_file: resolveOplStatePaths().agent_package_home_shortcut_preferences_file,
      },
      authority_boundary: refsOnlyAuthorityBoundary(),
    },
  };
}

function nativeLifecycleResult(
  action: ConfiguredCodexPluginCarrierAction,
  input: AgentPackageInstallInput,
  descriptorOverride?: InstalledPackageDescriptor,
) {
  const descriptor = descriptorOverride ?? requireDescriptor(input, action, { installed: action !== 'install' });
  const configuredCarrier = runConfiguredCodexPluginCarrier({
    descriptor: descriptor.carrier,
    action,
    dryRun: input.dryRun,
  });
  const status = input.dryRun
    ? 'validated_no_write'
    : action === 'remove'
      ? 'uninstalled'
      : action === 'repair'
        ? 'repaired'
        : action === 'update'
          ? 'updated'
          : 'installed';
  return {
    status,
    dry_run: input.dryRun === true,
    package_id: descriptor.manifest.package_id,
    configured_carrier: configuredCarrier,
    authority_boundary: refsOnlyAuthorityBoundary(),
  };
}

function requiredDependencyInstallResults(
  descriptor: InstalledPackageDescriptor,
  input: AgentPackageInstallInput,
  completed = new Set<string>(),
  visiting = new Set<string>(),
): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const dependency of descriptor.manifest.capability_dependencies) {
    if (!dependency.required || completed.has(dependency.package_id)) continue;
    if (visiting.has(dependency.package_id)) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Required Package dependency closure contains a cycle.',
        {
          package_id: descriptor.manifest.package_id,
          dependency_package_id: dependency.package_id,
          failure_code: 'agent_package_required_dependency_cycle',
        },
      );
    }
    const snapshot = packageSnapshot({ includeAvailable: true });
    const installed = snapshot.installed.get(dependency.package_id) ?? null;
    const ready = installed?.readiness.installed === true
      && installed.readiness.physical_status === 'available'
      && (installed.readiness.callability === 'callable'
        || installed.readiness.projection_callability === 'callable');
    if (ready) {
      completed.add(dependency.package_id);
      continue;
    }
    const dependencyDescriptor = snapshot.descriptors.get(dependency.package_id) ?? null;
    if (!dependencyDescriptor) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Required Package dependency is not installable from the current owner projections.',
        {
          package_id: descriptor.manifest.package_id,
          dependency_package_id: dependency.package_id,
          failure_code: 'agent_package_required_dependency_unavailable',
        },
      );
    }
    visiting.add(dependency.package_id);
    results.push(...requiredDependencyInstallResults(
      dependencyDescriptor,
      { ...input, packageId: dependency.package_id, manifestUrl: null },
      completed,
      visiting,
    ));
    results.push(nativeLifecycleResult(
      'install',
      { ...input, packageId: dependency.package_id, manifestUrl: null },
      dependencyDescriptor,
    ));
    visiting.delete(dependency.package_id);
    completed.add(dependency.package_id);
  }
  return results;
}

export async function runOplAgentPackageInstall(input: AgentPackageInstallInput) {
  if (input.manifestUrl) {
    const selected = await readManualAgentManifest(input);
    const result = nativeLifecycleResult('install', input, {
      manifest: selected.manifest,
      manifestPath: selected.source,
      manifest_sha256: sha256Text(selected.raw),
      sourcePath: selected.source,
      pluginId: selected.manifest.configured_codex_plugin_carrier!.carrier.pluginId,
      marketplaceSource: selected.manifest.configured_codex_plugin_carrier!.carrier.marketplaceSource,
      enabled: false,
      carrier: selected.manifest.configured_codex_plugin_carrier!,
      carrier_readback: {
        kind: 'codex_plugin_manager',
        identity: selected.manifest.configured_codex_plugin_carrier!.carrier.pluginId,
        source_ref: selected.source,
        version: selected.manifest.version,
        enabled: false,
        lifecycle_authority: 'carrier_owned',
      },
      readiness: {
        installed: false,
        physical_status: 'unavailable',
        callability: 'disabled',
      },
    });
    return {
      version: 'g2' as const,
      opl_agent_package_install: {
        surface_kind: 'opl_agent_package_install' as const,
        ...result,
        manifest_url: selected.source,
        trust_tier: input.trustTier,
      },
    };
  }
  const descriptor = requireDescriptor(input, 'install');
  const dependencyResults = requiredDependencyInstallResults(descriptor, input);
  return {
    version: 'g2' as const,
    opl_agent_package_install: {
      surface_kind: 'opl_agent_package_install' as const,
      ...nativeLifecycleResult('install', input, descriptor),
      required_dependency_install_results: dependencyResults,
    },
  };
}

export async function runOplAgentPackageUpdate(input: AgentPackageInstallInput) {
  return {
    version: 'g2' as const,
    opl_agent_package_update: {
      surface_kind: 'opl_agent_package_update' as const,
      ...nativeLifecycleResult('update', input),
    },
  };
}

type OplAgentPackageBulkUpdateInput = {
  action?: 'update' | 'repair';
  dryRun?: boolean;
};

export async function runOplAgentPackageBulkUpdate(
  input: OplAgentPackageBulkUpdateInput = {},
) {
  const action = input.action ?? 'update';
  const installed = packageSnapshot().installed;
  const descriptors = [...installed.values()]
    .sort((left, right) => left.manifest.package_id.localeCompare(right.manifest.package_id));
  const targets: Record<string, unknown>[] = [];
  for (const descriptor of descriptors) {
    const packageId = descriptor.manifest.package_id;
    try {
      const result = action === 'repair'
        ? await runOplAgentPackageRepair({ packageId, dryRun: input.dryRun })
        : await runOplAgentPackageUpdate({ packageId, dryRun: input.dryRun });
      targets.push({
        target_type: 'package',
        target_id: packageId,
        status: input.dryRun ? 'validated' : 'completed',
        reason: input.dryRun
          ? `native_carrier_owner_${action}_validated`
          : `native_carrier_owner_${action === 'repair' ? 'repaired' : 'updated'}`,
        action,
        result,
      });
    } catch (error) {
      targets.push({
        target_type: 'package',
        target_id: packageId,
        status: 'failed',
        reason: `native_carrier_owner_${action}_failed`,
        action,
        result: null,
        error: error instanceof FrameworkContractError
          ? error.toJSON()
          : { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return {
    surface_kind: 'opl_agent_package_bulk_update' as const,
    action,
    source: 'installed_owner_descriptor_and_native_carrier' as const,
    targets,
  };
}

export async function runOplAgentPackageRepair(input: AgentPackageRepairInput) {
  const descriptor = requireDescriptor(input, 'repair', { installed: true });
  const nativeRepair = nativeLifecycleResult('repair', input, descriptor);
  const managedPolicyRepair = descriptor.manifest.managed_policy_surface
    ? repairManagedPolicyDependenciesFromDescriptor({
        manifest: {
          package_id: descriptor.manifest.package_id,
          version: descriptor.manifest.version,
          plugin_id: descriptor.pluginId.split('@', 1)[0] ?? null,
          required_skill_ids: descriptor.manifest.required_skill_ids,
          managed_policy_surface: descriptor.manifest.managed_policy_surface,
        },
        sourceRoot: descriptor.sourcePath,
        activeCarrierIdentity: descriptor.carrier_readback.identity,
        dryRun: input.dryRun,
      })
    : null;
  return {
    version: 'g2' as const,
    opl_agent_package_repair: {
      surface_kind: 'opl_agent_package_repair' as const,
      ...nativeRepair,
      managed_policy_repair: managedPolicyRepair,
    },
  };
}

export async function runOplAgentPackageUninstall(input: AgentPackagePackageActionInput) {
  return {
    version: 'g2' as const,
    opl_agent_package_uninstall: {
      surface_kind: 'opl_agent_package_uninstall' as const,
      ...nativeLifecycleResult('remove', input),
    },
  };
}

export async function runOplAgentPackageExposureAction(
  action: 'hide' | 'unhide' | 'enable' | 'disable',
  input: AgentPackagePackageActionInput,
) {
  const descriptor = requireDescriptor(input, action, { installed: true });
  if (action === 'enable' || action === 'disable') {
    const configuredCarrier = runConfiguredCodexPluginCarrier({
      descriptor: descriptor.carrier,
      action,
      dryRun: input.dryRun,
    });
    return {
      version: 'g2' as const,
      opl_agent_package_exposure: {
        surface_kind: 'opl_agent_package_exposure' as const,
        status: input.dryRun ? 'validated_no_write' : action === 'enable' ? 'enabled' : 'disabled',
        action,
        dry_run: input.dryRun === true,
        package_id: descriptor.manifest.package_id,
        configured_carrier: configuredCarrier,
        authority_boundary: refsOnlyAuthorityBoundary(),
      },
    };
  }
  const shortcutIds = descriptor.manifest.presentation?.home_shortcuts
    .filter((shortcut) => shortcut.user_configurable)
    .map((shortcut) => shortcut.shortcut_id) ?? [];
  if (shortcutIds.length === 0) {
    throw new FrameworkContractError('contract_shape_invalid', 'Package has no configurable Home shortcuts.', {
      package_id: descriptor.manifest.package_id,
      action,
      failure_code: 'agent_package_home_shortcut_not_configurable',
    });
  }
  return withHomeShortcutPreferenceTransaction(input.dryRun === true, () => ({
    version: 'g2' as const,
    opl_agent_package_exposure: {
      surface_kind: 'opl_agent_package_exposure' as const,
      status: input.dryRun ? 'validated_no_write' : action === 'hide' ? 'hidden' : 'visible',
      action,
      dry_run: input.dryRun === true,
      package_id: descriptor.manifest.package_id,
      home_shortcut_preferences: updateHomeShortcutPreferences({
        packageId: descriptor.manifest.package_id,
        shortcutIds,
        visible: action === 'unhide',
        dryRun: input.dryRun === true,
      }),
      authority_boundary: refsOnlyAuthorityBoundary(),
    },
  }));
}

export async function runOplAgentPackageHomeShortcutPreferencesSet(
  input: AgentPackageHomeShortcutPreferencesSetInput,
) {
  const descriptor = requireDescriptor(input, 'preferences', { installed: true });
  const shortcut = descriptor.manifest.presentation?.home_shortcuts
    .find((entry) => entry.shortcut_id === input.shortcutId && entry.user_configurable) ?? null;
  if (!shortcut) {
    throw new FrameworkContractError('contract_shape_invalid', 'Home shortcut preference is not owner-configurable.', {
      package_id: descriptor.manifest.package_id,
      shortcut_id: input.shortcutId,
      failure_code: 'agent_package_home_shortcut_not_configurable',
    });
  }
  return withHomeShortcutPreferenceTransaction(input.dryRun === true, () => ({
    version: 'g2' as const,
    opl_agent_package_home_shortcut_preferences: {
      surface_kind: 'opl_agent_package_home_shortcut_preferences_set' as const,
      status: input.dryRun ? 'validated_no_write' : 'updated',
      dry_run: input.dryRun === true,
      package_id: descriptor.manifest.package_id,
      shortcut_id: input.shortcutId,
      visible: input.visible,
      sort_order: input.sortOrder,
      home_shortcut_preferences: typeof input.visible !== 'boolean'
        ? []
        : updateHomeShortcutPreferences({
            packageId: descriptor.manifest.package_id,
            shortcutIds: [input.shortcutId],
            visible: input.visible,
            dryRun: input.dryRun === true,
          }),
      authority_boundary: refsOnlyAuthorityBoundary(),
    },
  }));
}

export async function runOplAgentPackageFrameworkLink(input: {
  agentRoot: string;
  dryRun?: boolean;
  checkOnly?: boolean;
}) {
  return {
    version: 'g2' as const,
    opl_agent_package_framework_link: materializeStandardAgentFrameworkLink(input),
  };
}

export function createOplAgentPackageStatusReader() {
  const snapshot = packageSnapshot();
  return (input: OplAgentPackageStatusInput = {}) => buildPackageStatus(input, snapshot);
}

export function runOplAgentPackageStatus(input: OplAgentPackageStatusInput = {}) {
  return buildPackageStatus(input, packageSnapshot());
}

export function listOplAgentPackages(input: { detail?: 'fast' | 'full' } = {}) {
  const snapshot = packageSnapshot({ includeAvailable: true });
  const directory = directoryFrom(snapshot, input.detail ?? 'fast');
  const homeShortcutPreferences = mergedHomeShortcutPreferences(directory);
  return {
    version: 'g2' as const,
    opl_agent_packages: {
      surface_kind: 'opl_agent_package_readback' as const,
      status: 'available' as const,
      directory,
      installed_package_count: directory.installed_package_count,
      home_shortcut_preferences: homeShortcutPreferences,
      files: {
        home_shortcut_preferences_file: resolveOplStatePaths().agent_package_home_shortcut_preferences_file,
      },
      authority_boundary: refsOnlyAuthorityBoundary(),
    },
  };
}

function readInstalledOwnerProfileDefault() {
  const descriptors = discoverInstalledOwnerProfileDescriptors();
  if (descriptors.length !== 1) {
    return {
      surface_kind: 'opl_flow_default_user_instructions.v1' as const,
      source: 'installed_owner_descriptor' as const,
      source_path: null,
      source_root: null,
      package_version: null,
      status: descriptors.length === 0 ? 'unavailable' as const : 'invalid' as const,
      reason: descriptors.length === 0
        ? 'opl_flow_package_not_installed' as const
        : 'installed_owner_profile_descriptor_ambiguous' as const,
      content: null,
      sha256: null,
    };
  }
  const descriptor = descriptors[0]!;
  const declaredSourcePath = descriptor.manifest.profile_surface!.runtime_profile.source_path;
  try {
    const sourceRoot = fs.realpathSync(descriptor.sourcePath);
    const sourcePath = fs.realpathSync(path.resolve(sourceRoot, declaredSourcePath));
    if (!sourcePath.startsWith(`${sourceRoot}${path.sep}`) || !fs.statSync(sourcePath).isFile()) {
      throw new Error('profile source escaped its descriptor root');
    }
    const content = fs.readFileSync(sourcePath, 'utf8');
    return {
      surface_kind: 'opl_flow_default_user_instructions.v1' as const,
      source: 'installed_owner_descriptor' as const,
      source_path: sourcePath,
      source_root: sourceRoot,
      package_version: descriptor.manifest.version,
      status: 'available' as const,
      reason: null,
      content,
      sha256: sha256Text(content),
    };
  } catch {
    return {
      surface_kind: 'opl_flow_default_user_instructions.v1' as const,
      source: 'installed_owner_descriptor' as const,
      source_path: path.resolve(descriptor.sourcePath, declaredSourcePath),
      source_root: descriptor.sourcePath,
      package_version: descriptor.manifest.version,
      status: 'invalid' as const,
      reason: 'installed_owner_profile_source_missing_or_invalid' as const,
      content: null,
      sha256: null,
    };
  }
}

export function readOplFlowDefaultUserInstructions() {
  return readInstalledOwnerProfileDefault();
}

export function readOplFlowManagedPolicyDependencies(): AgentPackageManagedPolicyDependency[] {
  const descriptor = discoverInstalledPackageDescriptors().get('opl-flow');
  if (!descriptor?.manifest.managed_policy_surface) return [];
  try {
    return managedPolicyDependenciesFromDescriptor({
      manifest: {
        package_id: descriptor.manifest.package_id,
        version: descriptor.manifest.version,
        plugin_id: descriptor.pluginId.split('@', 1)[0] ?? null,
        required_skill_ids: descriptor.manifest.required_skill_ids,
        managed_policy_surface: descriptor.manifest.managed_policy_surface,
      },
      sourceRoot: descriptor.sourcePath,
    });
  } catch {
    return [];
  }
}

export function readOplFlowManagedDependencyIds() {
  return [...new Set(readOplFlowManagedPolicyDependencies().map((dependency) => dependency.id))];
}

export function readOplFlowManagedDependencies() {
  return readOplFlowManagedPolicyDependencies().map((dependency) => ({
    dependency_id: dependency.id,
    dependency_kind: dependency.kind,
    activation: dependency.activation,
    offline_bundle: dependency.offline_bundle ?? 'none',
    online_install_default: dependency.online_install_default,
    source: dependency.source ?? null,
    source_path: dependency.source_path ?? null,
    owner: dependency.owner ?? null,
    bundle_id: dependency.bundle_id ?? null,
    version_requirement: dependency.version_requirement ?? null,
    install_source: dependency.install_source ?? null,
    relationship: dependency.relationship ?? 'required',
    lifecycle_owner: dependency.lifecycle_owner
      ?? (dependency.kind === 'codex_skill' ? 'opl_packages' : 'opl_base'),
    update_mode: dependency.online_install_default ? 'silent_managed' : 'detect_only_guidance',
    observed_status: null,
    installed: dependency.kind === 'base' ? true : null,
  }));
}
