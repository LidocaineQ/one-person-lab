import fs from 'node:fs';
import path from 'node:path';
import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import { recordList, stringList, stringValue } from '../../../kernel/json-record.ts';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalAgentPackageId } from '../agent-package-identity.ts';
import { resolveFirstPartyPackageCatalog } from '../agent-package-first-party.ts';
import { getAgentPackageManifestByModuleId } from '../agent-package-manifests.ts';
import { getOplPackageSpecs } from '../package-distribution.ts';
import type { OplModuleId } from '../system-installation/shared.ts';
import type { ConfiguredCodexPluginCarrierReadback } from './configured-codex-plugin-carrier.ts';
import type {
  InstalledCodexPluginDescriptor,
  InstalledPackageCarrierReadback,
  InstalledPackageReadiness,
} from './installed-codex-plugin-directory.ts';
import { normalizePackageManifest } from './manifest-normalizers.ts';
import { resolveAgentPackageEffectiveSourcePolicy } from './source-policy.ts';
import {
  assertExplicitExternalRegistryClaim,
  refsOnlyAuthorityBoundary,
  uniqueStrings,
} from './shared.ts';
import type {
  AgentPackageAppContributions,
  AgentPackageConfiguredCodexPluginCarrierDescriptor,
  AgentPackagePackageActionInput,
  AgentPackagePresentation,
  AgentPackageRegistryDocument,
  AgentPackageRegistryEntry,
  AgentPackageRole,
} from './types.ts';

type PackageStatusReadback = {
  status?: string;
  recommended_action?: string | null;
  operational_ready?: boolean;
  launch_allowed?: boolean;
  launch_blocked_reason?: string | null;
};

type DirectoryCapabilityMetadata = {
  source: 'normalized_owner_manifest' | 'validated_registry_manifest';
  required_skill_ids: string[];
  optional_skill_refs: string[];
};

type DirectorySource = {
  package_id: string;
  display_name: string;
  publisher: string;
  description: string;
  tags: string[];
  package_role: AgentPackageRole | null;
  trust_tier: string;
  source: string;
  manifest_url: string;
  projected_version: string | null;
  selected_version: string | null;
  stable_version: string | null;
  registry_url: string | null;
  version_source_ref: string;
  source_kind:
    | 'first_party_framework_projection'
    | 'installed_codex_plugin_descriptor';
  registry_source_ref: string | null;
  capability_metadata: DirectoryCapabilityMetadata | null;
  presentation: AgentPackagePresentation | null;
  home_shortcut_ids: string[];
  configured_codex_plugin_carrier: AgentPackageConfiguredCodexPluginCarrierDescriptor | null;
  app_contributions: AgentPackageAppContributions | null;
  version_currentness: {
    status:
      | 'framework_projection_only'
      | 'installed_codex_plugin_descriptor';
    live_verified: boolean;
    source_ref: string | null;
    source_digest: string | null;
    checked_at: string | null;
  };
  installed_carrier_readback?: InstalledPackageCarrierReadback | null;
  installed_readiness?: InstalledPackageReadiness | null;
};

const PACKAGE_ROLES = new Set<AgentPackageRole>([
  'standard_agent',
  'capability_package',
  'workflow_profile',
]);

const frameworkRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../',
);

function isFirstPartyDirectorySource(source: DirectorySource) {
  return source.source_kind === 'first_party_framework_projection';
}
function packageRoleFromManifest(payload: unknown, manifestUrl: string) {
  if (!isRecord(payload)) {
    normalizePackageManifest(payload, manifestUrl);
    throw new Error('unreachable');
  }
  const manifest = normalizePackageManifest(payload, manifestUrl);
  return { manifest, role: manifest.package_role };
}

function normalizeDirectoryOwnerManifest(payload: unknown, manifestUrl: string) {
  try {
    return normalizePackageManifest(payload, manifestUrl);
  } catch (error) {
    if (
      error instanceof FrameworkContractError
      && error.details?.failure_code === 'agent_package_presentation_invalid'
      && isRecord(payload)
      && 'presentation' in payload
    ) {
      const { presentation: _invalidPresentation, ...manifestWithoutPresentation } = payload;
      return normalizePackageManifest(manifestWithoutPresentation, manifestUrl);
    }
    throw error;
  }
}

function manifestDirectoryMetadata(payload: unknown, manifestUrl: string) {
  const { manifest, role } = packageRoleFromManifest(payload, manifestUrl);
  const raw = isRecord(payload) ? payload : {};
  return {
    package_id: manifest.package_id,
    display_name: manifest.display_name,
    publisher: manifest.publisher,
    description: stringValue(raw.description) ?? `${manifest.display_name} package.`,
    tags: uniqueStrings([...stringList(raw.tags), role, manifest.source]),
    package_role: role,
    selected_version: manifest.version,
    required_skill_ids: [...manifest.required_skill_ids],
    optional_skill_refs: [...manifest.optional_skill_refs],
    presentation: manifest.presentation ?? null,
    configured_codex_plugin_carrier: manifest.configured_codex_plugin_carrier ?? null,
    app_contributions: manifest.app_contributions,
  };
}

function staticProjectionCarrier(spec: { package_id: string; package_manifest_ref: string }) {
  const manifestPath = path.resolve(frameworkRepoRoot, spec.package_manifest_ref);
  if (!fs.existsSync(manifestPath)) return null;
  const payload = parseJsonText(fs.readFileSync(manifestPath, 'utf8'));
  const codexSurface = isRecord(payload) && isRecord(payload.codex_surface)
    ? payload.codex_surface
    : null;
  if (!codexSurface || !Object.hasOwn(codexSurface, 'configured_codex_plugin_carrier')) return null;
  const manifest = normalizeDirectoryOwnerManifest(payload, pathToFileURL(manifestPath).toString());
  if (manifest.package_id !== spec.package_id) {
    throw new FrameworkContractError('contract_shape_invalid', 'First-party static projection identity must match its Package spec.', {
      package_id: spec.package_id,
      manifest_package_id: manifest.package_id,
      manifest_path: manifestPath,
      failure_code: 'first_party_package_projection_manifest_mismatch',
    });
  }
  return manifest.configured_codex_plugin_carrier ?? null;
}

function selectedCatalogVersion(entry: Record<string, unknown>, packageId: string) {
  const selectedVersion = stringValue(entry.selected_version);
  const versions = recordList(entry.versions);
  const selected = versions.find((candidate) =>
    stringValue(candidate.package_version) === selectedVersion
    && candidate.selection_status !== 'retained_history'
  );
  if (!selectedVersion || !selected) {
    throw new FrameworkContractError('contract_shape_invalid', 'OPL package catalog entry has no selected stable version.', {
      package_id: packageId,
      selected_version: selectedVersion,
      failure_code: 'agent_package_directory_catalog_selection_invalid',
    });
  }
  return { selectedVersion, selected };
}

export function isOplPackageCatalog(payload: unknown) {
  if (!isRecord(payload)) return false;
  return payload.surface_kind === 'opl_package_catalog.v1'
    || payload.package_catalog_surface_kind === 'opl_package_catalog.v1';
}

export function normalizePackageCatalogDocument(
  payload: unknown,
  registryUrl: string,
  registrySha256: string,
): AgentPackageRegistryDocument {
  if (!isRecord(payload) || !isRecord(payload.packages) || !isRecord(payload.packages.package_catalog)) {
    throw new FrameworkContractError('contract_shape_invalid', 'OPL package catalog must declare packages.package_catalog.', {
      registry_url: registryUrl,
      failure_code: 'agent_package_directory_catalog_invalid',
    });
  }
  const entries = Object.entries(payload.packages.package_catalog).map(([declaredId, rawEntry], index) => {
    if (!isRecord(rawEntry)) {
      throw new FrameworkContractError('contract_shape_invalid', 'OPL package catalog entries must be objects.', {
        registry_url: registryUrl,
        entry_index: index,
        failure_code: 'agent_package_directory_catalog_invalid',
      });
    }
    const packageId = canonicalAgentPackageId(stringValue(rawEntry.package_id) ?? declaredId);
    if (!packageId || packageId !== declaredId) {
      throw new FrameworkContractError('contract_shape_invalid', 'OPL package catalog identity must be canonical and match its key.', {
        registry_url: registryUrl,
        declared_id: declaredId,
        package_id: packageId,
        failure_code: 'agent_package_directory_catalog_identity_invalid',
      });
    }
    if (resolveFirstPartyPackageCatalog(packageId)) {
      throw new FrameworkContractError('contract_shape_invalid', 'External package catalogs cannot claim canonical first-party package identities.', {
        registry_url: registryUrl,
        package_id: packageId,
        failure_code: 'agent_package_registry_first_party_identity_collision',
      });
    }
    const declaredSource = assertExplicitExternalRegistryClaim(rawEntry.source, {
      field: 'source',
      sourceLabel: `${registryUrl}#packages.package_catalog.${packageId}`,
      failureCode: 'agent_package_directory_catalog_source_invalid',
    });
    const declaredTrustTier = assertExplicitExternalRegistryClaim(rawEntry.trust_tier, {
      field: 'trust_tier',
      sourceLabel: `${registryUrl}#packages.package_catalog.${packageId}`,
      failureCode: 'agent_package_directory_catalog_trust_tier_invalid',
    });
    const { selectedVersion, selected } = selectedCatalogVersion(rawEntry, packageId);
    const manifestUrl = stringValue(selected.manifest_url);
    const manifestJson = stringValue(selected.manifest_json);
    if (!manifestUrl || !manifestJson) {
      throw new FrameworkContractError('contract_shape_invalid', 'Selected package catalog versions require inline manifest identity.', {
        registry_url: registryUrl,
        package_id: packageId,
        failure_code: 'agent_package_directory_catalog_manifest_missing',
      });
    }
    const metadata = manifestDirectoryMetadata(parseJsonText(manifestJson), manifestUrl);
    const declaredRole = stringValue(rawEntry.package_role);
    if (!declaredRole || !PACKAGE_ROLES.has(declaredRole as AgentPackageRole) || declaredRole !== metadata.package_role) {
      throw new FrameworkContractError('contract_shape_invalid', 'OPL package catalog role must match the selected manifest.', {
        registry_url: registryUrl,
        package_id: packageId,
        declared_role: declaredRole,
        manifest_role: metadata.package_role,
        allowed_roles: [...PACKAGE_ROLES],
        failure_code: 'agent_package_directory_catalog_role_invalid',
      });
    }
    if (metadata.package_id !== packageId || metadata.selected_version !== selectedVersion) {
      throw new FrameworkContractError('contract_shape_invalid', 'OPL package catalog selection must match its inline manifest.', {
        registry_url: registryUrl,
        package_id: packageId,
        manifest_package_id: metadata.package_id,
        selected_version: selectedVersion,
        manifest_version: metadata.selected_version,
        failure_code: 'agent_package_directory_catalog_manifest_mismatch',
      });
    }
    return {
      package_id: packageId,
      display_name: stringValue(rawEntry.display_name) ?? metadata.display_name,
      publisher: stringValue(rawEntry.publisher) ?? metadata.publisher,
      description: stringValue(rawEntry.description) ?? metadata.description,
      tags: uniqueStrings([...stringList(rawEntry.tags), ...metadata.tags]),
      package_role: metadata.package_role,
      source: declaredSource,
      manifest_url: manifestUrl,
      version_source_ref: `${manifestUrl}#/version`,
      selected_version: selectedVersion,
      stable_version: selectedVersion,
      manifest_validation: 'catalog_inline_manifest' as const,
      trust_tier: declaredTrustTier,
      starter_default: rawEntry.starter_default === true,
      codex_visible_entry: null,
      required_skill_ids: metadata.required_skill_ids,
      optional_skill_ids: metadata.optional_skill_refs,
      home_shortcut_ids: [],
      presentation: metadata.presentation ?? null,
      display_policy: null,
      ordinary_user_source: null,
      configured_codex_plugin_carrier: metadata.configured_codex_plugin_carrier,
      app_contributions: metadata.app_contributions,
    } satisfies AgentPackageRegistryEntry;
  });
  return {
    registry_url: registryUrl,
    registry_sha256: registrySha256,
    entries,
  };
}

function firstPartyDirectorySources(): DirectorySource[] {
  return getOplPackageSpecs().map((spec) => {
    const ownerManifest = spec.owner_manifest_kind === 'standard_agent' || spec.module_id === 'scholarskills'
      ? getAgentPackageManifestByModuleId(spec.module_id as OplModuleId)
      : null;
    const capabilityMetadata: DirectoryCapabilityMetadata | null = spec.package_role === 'standard_agent'
      && ownerManifest
      ? {
          source: 'normalized_owner_manifest',
          required_skill_ids: [...ownerManifest.codex_surface.required_skill_ids],
          optional_skill_refs: [],
        }
      : null;
    const projectedCarrier = staticProjectionCarrier(spec);
    return {
      package_id: spec.package_id,
      display_name: spec.label,
      publisher: 'one-person-lab',
      description: spec.description,
      tags: [...spec.tags],
      package_role: spec.package_role,
      trust_tier: spec.trust_tier,
      source: 'first_party',
      manifest_url: spec.package_manifest_ref,
      projected_version: spec.selected_version,
      selected_version: null,
      stable_version: null,
      registry_url: null,
      version_source_ref: `${spec.package_manifest_ref}#/version`,
      source_kind: 'first_party_framework_projection',
      registry_source_ref: spec.package_manifest_ref,
      capability_metadata: capabilityMetadata,
      presentation: ownerManifest?.presentation ?? null,
      home_shortcut_ids: [],
      configured_codex_plugin_carrier: projectedCarrier,
      app_contributions: null,
      version_currentness: {
        status: 'framework_projection_only',
        live_verified: false,
        source_ref: spec.package_manifest_ref,
        source_digest: null,
        checked_at: null,
      },
    };
  });
}

export function firstPartyConfiguredCarrierDescriptors() {
  const descriptors = new Map<string, AgentPackageConfiguredCodexPluginCarrierDescriptor>();
  for (const source of firstPartyDirectorySources()) {
    if (source.configured_codex_plugin_carrier) {
      descriptors.set(source.package_id, source.configured_codex_plugin_carrier);
    }
  }
  return descriptors;
}

function installedCodexPluginDirectorySource(
  discovered: InstalledCodexPluginDescriptor,
): DirectorySource {
  const manifest = discovered.manifest;
  return {
    package_id: manifest.package_id,
    display_name: manifest.display_name,
    publisher: manifest.publisher,
    description: `${manifest.display_name} installed package.`,
    tags: uniqueStrings(['installed', 'codex_plugin', manifest.package_role]),
    package_role: manifest.package_role,
    trust_tier: manifest.source === 'first_party' ? 'first_party' : 'installed_descriptor',
    source: manifest.source,
    manifest_url: pathToFileURL(discovered.manifestPath).toString(),
    projected_version: null,
    selected_version: manifest.version,
    stable_version: null,
    registry_url: null,
    version_source_ref: `${discovered.manifestPath}#/version`,
    source_kind: 'installed_codex_plugin_descriptor',
    registry_source_ref: null,
    capability_metadata: manifest.package_role === 'standard_agent'
      ? {
          source: 'normalized_owner_manifest',
          required_skill_ids: [...manifest.required_skill_ids],
          optional_skill_refs: [...manifest.optional_skill_refs],
        }
      : null,
    presentation: manifest.presentation ?? null,
    home_shortcut_ids: manifest.presentation?.home_shortcuts.map((entry) => entry.shortcut_id) ?? [],
    configured_codex_plugin_carrier: discovered.carrier,
    app_contributions: manifest.app_contributions ?? null,
    version_currentness: {
      status: 'installed_codex_plugin_descriptor',
      live_verified: false,
      source_ref: discovered.manifestPath,
      source_digest: null,
      checked_at: null,
    },
    installed_carrier_readback: discovered.carrier_readback,
    installed_readiness: discovered.readiness,
  };
}

function packageAction(
  actionId: string,
  payload: Record<string, unknown>,
  requiredPayloadFields: string[],
  confirmationRequired: boolean,
) {
  const semantics = actionId === 'install_from_manifest_url'
      ? { semantic: 'install', surface: 'settings' }
      : actionId === 'agent_package_activate'
        ? { semantic: 'activate', surface: 'workspace' }
        : actionId === 'agent_package_update'
          ? { semantic: 'update', surface: 'settings' }
          : actionId === 'agent_package_repair'
            ? { semantic: 'repair', surface: 'settings' }
            : actionId === 'agent_package_preferences_set'
              ? payload.exposure_action === 'enable'
                ? { semantic: 'enable', surface: 'settings' }
                : { semantic: 'preferences', surface: 'settings' }
              : actionId === 'agent_package_uninstall'
                ? { semantic: 'uninstall', surface: 'settings' }
                : { semantic: 'custom', surface: 'settings' };
  return {
    action_id: actionId,
    action_ref: `app_state.actions#${actionId}`,
    payload,
    required_payload_fields: requiredPayloadFields,
    confirmation_required: confirmationRequired,
    semantic: semantics.semantic,
    surface: semantics.surface,
  };
}

function installPayload(source: DirectorySource) {
  if (isFirstPartyDirectorySource(source)) {
    return { package_id: source.package_id };
  }
  return source.registry_url
    ? {
        package_id: source.package_id,
        registry_url: source.registry_url,
      }
    : {
        package_id: source.package_id,
        manifest_url: source.manifest_url,
        trust_tier: source.trust_tier,
      };
}

function activationPayload(
  source: DirectorySource,
  context: Pick<AgentPackagePackageActionInput, 'scope' | 'targetWorkspace' | 'targetQuest'> | null,
) {
  const scope = context?.scope ?? 'workspace';
  return {
    package_id: source.package_id,
    scope,
    ...(scope === 'workspace' && context?.targetWorkspace
      ? { target_workspace: context.targetWorkspace }
      : {}),
    ...(scope === 'quest' && context?.targetQuest
      ? { target_quest: context.targetQuest }
      : {}),
  };
}

function activationAction(
  source: DirectorySource,
  context: Pick<AgentPackagePackageActionInput, 'scope' | 'targetWorkspace' | 'targetQuest'> | null,
) {
  const payload = activationPayload(source, context);
  return packageAction('agent_package_activate', payload, [
    'package_id',
    payload.scope === 'workspace' ? 'target_workspace' : 'target_quest',
  ], false);
}

function availableActions(
  source: DirectorySource,
  installed: boolean,
  context: Pick<AgentPackagePackageActionInput, 'scope' | 'targetWorkspace' | 'targetQuest'> | null,
  activationAllowed: boolean,
  automaticUpdateAllowed: boolean,
  configuredCarrierDisabled: boolean,
) {
  if (!source.package_role) {
    if (installed) {
      return [
        packageAction('agent_package_repair', { package_id: source.package_id }, ['package_id'], true),
        packageAction('agent_package_uninstall', { package_id: source.package_id }, ['package_id'], true),
      ];
    }
    return [];
  }
  if (!installed) {
    const payload = installPayload(source);
    return [packageAction(
      'install_from_manifest_url',
      payload,
      Object.hasOwn(payload, 'registry_url')
        ? ['registry_url', 'package_id']
        : Object.hasOwn(payload, 'manifest_url')
          ? ['manifest_url', 'trust_tier']
          : ['package_id'],
      true,
    )];
  }
  const updatePayload = isFirstPartyDirectorySource(source)
    ? { package_id: source.package_id }
    : source.registry_url
      ? {
          package_id: source.package_id,
          registry_url: source.registry_url,
        }
      : {
          package_id: source.package_id,
          manifest_url: source.manifest_url,
          trust_tier: source.trust_tier,
        };
  return [
    ...(activationAllowed
      ? [activationAction(source, context)]
      : []),
    ...(automaticUpdateAllowed
      ? [packageAction('agent_package_update', updatePayload, ['package_id'], true)]
      : []),
    packageAction('agent_package_repair', { package_id: source.package_id }, ['package_id'], true),
    packageAction(
      'agent_package_preferences_set',
      configuredCarrierDisabled
        ? { package_id: source.package_id, exposure_action: 'enable' }
        : { package_id: source.package_id },
      configuredCarrierDisabled
        ? ['package_id', 'exposure_action']
        : ['package_id', 'exposure_action or shortcut_id'],
      false,
    ),
    packageAction('agent_package_uninstall', { package_id: source.package_id }, ['package_id'], true),
  ];
}

function recommendedActionId(input: {
  installed: boolean;
  statusAction: string | null;
  availableActionIds: Set<string>;
}) {
  if (!input.installed) {
    if (input.availableActionIds.has('install_from_manifest_url')) return 'install_from_manifest_url';
    return null;
  }
  const candidate = input.statusAction;
  const normalized = candidate === 'repair'
    ? 'agent_package_repair'
    : candidate === 'install_from_manifest_url'
      ? 'agent_package_update'
      : candidate;
  if (normalized === 'agent_package_activate') return null;
  if (normalized && input.availableActionIds.has(normalized)) return normalized;
  return null;
}

export function buildAgentPackageDirectory(input: {
  detail: 'fast' | 'full';
  configuredCarrierReadbacks?: ReadonlyMap<string, ConfiguredCodexPluginCarrierReadback>;
  installedCodexPluginDescriptors?: ReadonlyMap<string, InstalledCodexPluginDescriptor>;
  actionContext?: (packageId: string) => Pick<AgentPackagePackageActionInput, 'scope' | 'targetWorkspace' | 'targetQuest'> | null;
}) {
  const sources = new Map(firstPartyDirectorySources()
    .map((entry) => [entry.package_id, entry]));
  for (const discovered of input.installedCodexPluginDescriptors?.values() ?? []) {
    const existing = sources.get(discovered.manifest.package_id);
    if (existing && isFirstPartyDirectorySource(existing)) continue;
    sources.set(discovered.manifest.package_id, installedCodexPluginDirectorySource(discovered));
  }
  const entries = [...sources.values()].map((source) => {
    const installedDescriptor = input.installedCodexPluginDescriptors?.get(source.package_id) ?? null;
    const carrierOwned = Boolean(source.configured_codex_plugin_carrier || installedDescriptor);
    const carrierReadiness = installedDescriptor?.readiness ?? null;
    const configuredCarrier = input.configuredCarrierReadbacks?.get(source.package_id) ?? null;
    const configuredCarrierInstalled = configuredCarrier?.status === 'installed';
    const configuredCarrierDisabled = Boolean(
      configuredCarrierInstalled
      && configuredCarrier?.reason === 'configured_native_carrier_disabled',
    );
    const configuredCarrierNotInstalled = Boolean(
      configuredCarrier
      && (
        configuredCarrier.status === 'not_installed'
        || (
          configuredCarrier.status === 'physical_unavailable'
          && configuredCarrier.carrier.precedence === 'not_present'
        )
      ),
    );
    const installed = carrierOwned
      && (configuredCarrierInstalled || carrierReadiness?.installed === true);
    const configuredCarrierAttention = Boolean(
      configuredCarrier
      && !configuredCarrierNotInstalled
      && (
        configuredCarrier.status === 'physical_unavailable'
        || configuredCarrier.executor.status !== 'callable'
        || configuredCarrier.carrier.precedence !== 'exact_single_source'
      ),
    );
    const sourcePolicy = resolveFirstPartyPackageCatalog(source.package_id)
      ? resolveAgentPackageEffectiveSourcePolicy(source.package_id, { profile: input.detail })
      : null;
    const effectiveSource = source;
    const roleKnown = effectiveSource.package_role !== null;
    const roleRepairRequired = installed && !roleKnown;
    let status: PackageStatusReadback = {};
    if (carrierReadiness) {
      const carrierReady = carrierReadiness.installed
        && carrierReadiness.physical_status === 'available'
        && carrierReadiness.callability === 'callable';
      status = {
        status: carrierReady ? 'available' : 'attention_needed',
        recommended_action: carrierReady
          ? null
          : configuredCarrierDisabled
            ? 'agent_package_preferences_set'
            : 'agent_package_repair',
        operational_ready: carrierReady,
        launch_allowed: carrierReady,
        launch_blocked_reason: carrierReady
          ? null
          : configuredCarrierDisabled
            ? 'configured_native_carrier_disabled'
            : carrierReadiness.physical_status !== 'available'
              ? 'carrier_source_unavailable'
              : carrierReadiness.callability !== 'callable'
                ? 'carrier_disabled'
                : 'carrier_not_installed',
      };
    } else if (configuredCarrier) {
      status = {
        status: configuredCarrierAttention
          ? 'attention_needed'
          : configuredCarrierNotInstalled
            ? 'not_installed'
            : 'available',
        recommended_action: configuredCarrierDisabled
          ? 'agent_package_preferences_set'
          : configuredCarrierInstalled
            ? 'agent_package_repair'
            : null,
        operational_ready: configuredCarrierInstalled && !configuredCarrierAttention,
        launch_allowed: configuredCarrierInstalled && !configuredCarrierAttention,
        launch_blocked_reason: configuredCarrierAttention
          ? configuredCarrier.reason ?? 'configured_native_carrier_attention_needed'
          : configuredCarrierInstalled
            ? null
            : 'package_not_installed',
      };
    }
    const activated = installed
      && !roleRepairRequired
      && status.operational_ready === true
      && status.launch_allowed === true;
    const sourcePolicyStatus: 'not_applicable' | 'manual_required' | 'current' = !sourcePolicy
      ? 'not_applicable'
      : sourcePolicy.desired_source_kind === 'developer_checkout_override'
        ? !sourcePolicy.developer_checkout_available
          ? 'manual_required'
          : 'current'
        : 'current';
    const actions = availableActions(
      effectiveSource,
      installed,
      input.actionContext?.(source.package_id) ?? null,
      configuredCarrier ? false : true,
      sourcePolicy?.package_channel_auto_update === true || !sourcePolicy,
      configuredCarrierDisabled,
    );
    const recommendedAction = recommendedActionId({
      installed,
      statusAction: roleRepairRequired
        ? 'agent_package_repair'
        : configuredCarrierInstalled
          && configuredCarrier?.executor.status === 'callable'
          && configuredCarrier.carrier.precedence === 'exact_single_source'
          ? null
          : status.recommended_action ?? null,
      availableActionIds: new Set(actions.map((action) => action.action_id)),
    });
    const readinessStatus = installed && !roleKnown
      ? 'migration_required'
      : !installed
      ? roleKnown ? 'not_installed' : 'migration_required'
        : activated
          ? 'ready'
          : 'attention_needed';
    return {
      package_id: source.package_id,
      display_name: source.display_name,
      publisher: source.publisher,
      description: source.description,
      tags: source.tags,
      package_role: effectiveSource.package_role,
      capability_metadata: effectiveSource.package_role === 'standard_agent'
        ? effectiveSource.capability_metadata
        : null,
      display_name_i18n: effectiveSource.presentation?.display_name_i18n ?? null,
      description_i18n: effectiveSource.presentation?.description_i18n ?? null,
      session_routing_summary_i18n: effectiveSource.presentation?.session_routing_summary_i18n ?? null,
      home_shortcuts: effectiveSource.presentation?.home_shortcuts ?? [],
      home_shortcut_ids: effectiveSource.home_shortcut_ids,
      app_contributions: effectiveSource.app_contributions,
      capability_dependency_summary: null,
      configured_carrier: configuredCarrier,
      installed_carrier_readback: effectiveSource.installed_carrier_readback ?? null,
      installed_readiness: effectiveSource.installed_readiness ?? null,
      role_state: {
        status: !installed
          ? roleKnown ? 'declared' : 'migration_required'
          : !roleKnown
            ? 'migration_required'
            : 'current',
        source: source.source_kind,
        discovered_role: source.package_role,
        installed_role: installed ? source.package_role : null,
        diagnostic: null,
      },
      trust_tier: source.trust_tier,
      source_explanation: {
        kind: source.source_kind,
        source: source.source,
        summary: source.source_kind === 'first_party_framework_projection'
            ? 'Framework-owned Package identity projection; owner-channel currentness was not requested for this readback.'
          : source.source_kind === 'installed_codex_plugin_descriptor'
                ? 'Owner descriptor discovered from the installed Codex plugin carrier source root.'
          : 'Installed owner descriptor discovered from the native carrier source root.',
        owner_channel_ref: source.source_kind === 'first_party_framework_projection'
          ? resolveFirstPartyPackageCatalog(source.package_id)?.catalogSource.catalog_ref ?? null
          : null,
        registry_url: source.registry_url,
        registry_source_ref: source.registry_source_ref,
        version_source_ref: source.version_source_ref,
        installed_source_kind: null,
        effective_source_policy: sourcePolicy,
        source_policy_status: sourcePolicyStatus,
      },
      manifest_url: source.manifest_url,
      projected_version: source.projected_version,
      selected_version: source.selected_version,
      stable_version: source.stable_version,
      version_currentness: source.version_currentness,
      package_currentness: !installed
        ? {
            status: 'unknown',
            reasons: ['owner_channel_currentness_not_requested'],
          }
        : sourcePolicyStatus === 'manual_required'
          ? {
              status: 'manual_required',
              reasons: [
                'developer_checkout_unavailable',
                'owner_channel_currentness_not_requested',
              ],
            }
          : {
                status: 'unknown',
                reasons: ['owner_channel_currentness_not_requested'],
              },
      installed_version: configuredCarrierInstalled
        ? configuredCarrier?.installed_version
          ?? source.installed_carrier_readback?.version
          ?? null
        : null,
      installed_content_digest: null,
      installed_artifact_digest: null,
      installed,
      activated,
      installability: {
        status: installed
          ? roleRepairRequired ? 'migration_required' : 'installed'
          : roleKnown ? 'installable' : 'migration_required',
        installable: !installed && roleKnown,
      },
      readiness: {
        status: readinessStatus,
        operational_ready: installed && status.operational_ready === true,
        launch_allowed: installed && status.launch_allowed === true,
        verification_deferred: false,
        reason: !installed
          ? roleKnown ? 'package_not_installed' : 'registry_role_refresh_required'
          : roleRepairRequired
            ? 'installed_role_migration_required'
            : status.launch_blocked_reason ?? (activated ? null : 'package_not_operational'),
        detail_surface: `opl packages status --package-id ${source.package_id} --json`,
        status_read_error: null,
      },
      recommended_action: recommendedAction,
      recommended_action_ref: actions.find((action) => action.action_id === recommendedAction) ?? null,
      available_actions: actions,
      authority_boundary: refsOnlyAuthorityBoundary(),
    };
  }).sort((left, right) => left.display_name.localeCompare(right.display_name, 'en'));
  return {
    surface_kind: 'opl_agent_package_directory.v1',
    status: entries.some((entry) => entry.role_state.status === 'migration_required'
      || entry.role_state.status === 'mismatch_repair_required'
      || entry.readiness.status === 'repair_required')
      ? 'attention_required'
      : 'available',
    source_catalog_kind: 'opl_framework_package_projection+installed_descriptor',
    first_party_owner_currentness: {
      status: 'not_requested',
      live_verified: false,
      channel_kind: 'per_package_owner_oci_latest_stable',
      checked_at: null,
    },
    detail: input.detail,
    entry_count: entries.length,
    installed_package_count: entries.filter((entry) => entry.installed).length,
    installable_package_count: entries.filter((entry) => entry.installability.installable).length,
    migration_required_count: entries.filter((entry) => entry.installability.status === 'migration_required').length,
    entries,
    authority_boundary: refsOnlyAuthorityBoundary(),
  };
}
