import { FrameworkContractError } from '../../../kernel/contract-validation.ts';
import type {
  AgentPackageCapabilityDependency,
  AgentPackageDependencyReadinessItem,
  AgentPackageDependencyReadiness,
  AgentPackageManifest,
  AgentPackageResolvedDependency,
} from './types.ts';

const DEPENDENCY_HARD_FAILURE_REASONS = new Set([
  'package_id_mismatch',
  'dependency_lock_missing',
  'dependency_not_installed',
  'dependency_physical_unavailable',
  'dependency_disabled',
  'capability_provider_missing',
  'capability_abi_mismatch',
  'consumer_profile_missing',
  'consumer_profile_consumer_mismatch',
  'consumer_profile_requirements_mismatch',
  'required_exports_missing',
  'required_modules_missing',
]);

export function manifestContentDigest(manifest: AgentPackageManifest, manifestSha256: string) {
  return manifest.content_digest
    ?? manifest.distribution_payload?.payload_digest_ref
    ?? `sha256:${manifestSha256}`;
}

function sameStringSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function capabilityProfileCompatibility(
  dependency: AgentPackageCapabilityDependency,
  provider: Pick<AgentPackageManifest, 'capability_provider'>,
  consumerAgentId: string | null,
) {
  const providerCapability = provider.capability_provider;
  const profileId = dependency.consumer_profile_id ?? null;
  if (!profileId) {
    const providerExports = new Set(providerCapability?.exports
      .filter((entry) => entry.install_mode === 'core_required')
      .map((entry) => entry.export_id) ?? []);
    const providerModules = new Set(providerCapability?.module_export_ids ?? []);
    return {
      reasons: [] as string[],
      missingExports: dependency.required_export_ids.filter((exportId) => !providerExports.has(exportId)),
      missingModules: dependency.required_module_ids.filter((moduleId) => !providerModules.has(moduleId)),
    };
  }

  const profile = providerCapability?.consumer_profiles
    ?.find((entry) => entry.profile_id === profileId);
  if (!profile) {
    return {
      reasons: ['consumer_profile_missing'],
      missingExports: [...dependency.required_export_ids],
      missingModules: [...dependency.required_module_ids],
    };
  }

  const reasons: string[] = [];
  if (profile.consumer_agent_id !== consumerAgentId) {
    reasons.push('consumer_profile_consumer_mismatch');
  }
  if (
    !sameStringSet(profile.required_export_ids, dependency.required_export_ids)
    || !sameStringSet(profile.required_module_ids, dependency.required_module_ids)
  ) {
    reasons.push('consumer_profile_requirements_mismatch');
  }
  const providerExports = new Set(providerCapability?.exports.map((entry) => entry.export_id) ?? []);
  const providerModules = new Set(providerCapability?.module_export_ids ?? []);
  const missingExports = [...new Set([
    ...profile.required_export_ids.filter((exportId) => !dependency.required_export_ids.includes(exportId)),
    ...dependency.required_export_ids.filter((exportId) => !profile.required_export_ids.includes(exportId)),
    ...profile.required_export_ids.filter((exportId) => !providerExports.has(exportId)),
  ])];
  const missingModules = [...new Set([
    ...profile.required_module_ids.filter((moduleId) => !dependency.required_module_ids.includes(moduleId)),
    ...dependency.required_module_ids.filter((moduleId) => !profile.required_module_ids.includes(moduleId)),
    ...profile.required_module_ids.filter((moduleId) => !providerModules.has(moduleId)),
  ])];
  return { reasons, missingExports, missingModules };
}

export function validateCapabilityProvider(
  dependency: AgentPackageCapabilityDependency,
  provider: AgentPackageManifest,
  manifestSha256: string,
  consumerAgentId: string | null = null,
): AgentPackageResolvedDependency {
  const reasons: string[] = [];
  if (provider.package_id !== dependency.package_id) reasons.push('package_id_mismatch');
  const profileCompatibility = capabilityProfileCompatibility(dependency, provider, consumerAgentId);
  reasons.push(...profileCompatibility.reasons);
  const missingExports = profileCompatibility.missingExports;
  const missingModules = profileCompatibility.missingModules;
  if (missingExports.length > 0) reasons.push('required_exports_missing');
  if (missingModules.length > 0) reasons.push('required_modules_missing');
  if (reasons.length > 0) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability dependency provider is incompatible with the consumer manifest.', {
      package_id: dependency.package_id,
      provider_version: provider.version,
      version_requirement: dependency.version_requirement,
      expected_capability_abi: dependency.capability_abi,
      provider_capability_abi: provider.capability_provider?.capability_abi ?? null,
      consumer_agent_id: consumerAgentId,
      consumer_profile_id: dependency.consumer_profile_id ?? null,
      missing_required_export_ids: missingExports,
      missing_required_module_ids: missingModules,
      reasons,
      failure_code: 'agent_package_dependency_incompatible',
    });
  }
  const contentDigest = manifestContentDigest(provider, manifestSha256);
  return {
    package_id: dependency.package_id,
    required: dependency.required,
    dependency_kind: dependency.dependency_kind,
    consumer_profile_id: dependency.consumer_profile_id ?? null,
    required_export_ids: dependency.required_export_ids,
    required_module_ids: dependency.required_module_ids,
    installed_version: provider.version,
    manifest_url: '',
    manifest_sha256: manifestSha256,
    content_digest: contentDigest,
    package_lock_ref: '',
  };
}

/**
 * Read the required capability closure from installed owner descriptors only.
 * This is intentionally independent from the retired lock/index and lifecycle
 * state so ordinary status remains carrier-authoritative after the hard cut.
 */
export function descriptorDependencyReadiness(input: {
  root: Pick<AgentPackageManifest, 'agent_id' | 'capability_dependencies'>;
  providers: ReadonlyMap<string, {
    manifest: Pick<AgentPackageManifest, 'package_id' | 'version' | 'capability_provider'>;
    manifest_sha256: string | null;
    content_digest: string | null;
    readiness: {
      installed: boolean;
      physical_status: 'available' | 'unavailable';
      callability: 'callable' | 'disabled';
      projection_callability?: 'callable' | 'disabled';
    };
  }>;
}): AgentPackageDependencyReadiness {
  const items = input.root.capability_dependencies.map((dependency) => {
    const provider = input.providers.get(dependency.package_id);
    const reasons: string[] = [];
    let missingRequiredExportIds = [...dependency.required_export_ids];
    let missingRequiredModuleIds = [...dependency.required_module_ids];
    if (!provider) {
      reasons.push('dependency_not_installed');
    } else {
      if (!provider.readiness.installed) reasons.push('dependency_not_installed');
      if (provider.readiness.physical_status !== 'available') {
        reasons.push('dependency_physical_unavailable');
      }
      if ((provider.readiness.projection_callability ?? provider.readiness.callability) !== 'callable') {
        reasons.push('dependency_disabled');
      }
      if (!provider.manifest.capability_provider) {
        reasons.push('capability_provider_missing');
      } else {
        if (provider.manifest.capability_provider.capability_abi !== dependency.capability_abi) {
          reasons.push('capability_abi_mismatch');
        }
        const profileCompatibility = capabilityProfileCompatibility(
          dependency,
          provider.manifest,
          input.root.agent_id,
        );
        reasons.push(...profileCompatibility.reasons);
        missingRequiredExportIds = profileCompatibility.missingExports;
        missingRequiredModuleIds = profileCompatibility.missingModules;
        if (missingRequiredExportIds.length > 0) reasons.push('required_exports_missing');
        if (missingRequiredModuleIds.length > 0) reasons.push('required_modules_missing');
      }
    }
    const hardFailureReasons = reasons.filter((reason) => DEPENDENCY_HARD_FAILURE_REASONS.has(reason));
    const status: AgentPackageDependencyReadinessItem['status'] = reasons.includes('dependency_not_installed')
      ? 'missing'
      : hardFailureReasons.length > 0
        ? 'incompatible'
        : 'current';
    return {
      package_id: dependency.package_id,
      required: dependency.required,
      consumer_profile_id: dependency.consumer_profile_id ?? null,
      required_export_ids: dependency.required_export_ids,
      required_module_ids: dependency.required_module_ids,
      installed_version: provider?.manifest.version ?? null,
      manifest_sha256: provider?.manifest_sha256 ?? null,
      content_digest: provider?.content_digest ?? null,
      status,
      reasons,
      missing_required_export_ids: missingRequiredExportIds,
      missing_required_module_ids: missingRequiredModuleIds,
    };
  });
  const status = items.some((entry) => entry.status === 'missing')
    ? 'missing'
    : items.some((entry) => entry.status === 'incompatible')
      ? 'incompatible'
      : 'current';
  return {
    status,
    operational_ready: items.every((entry) => !entry.required
      || !entry.reasons.some((reason) => DEPENDENCY_HARD_FAILURE_REASONS.has(reason))),
    dependencies: items,
  };
}
