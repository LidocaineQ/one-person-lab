import fs from 'node:fs';
import path from 'node:path';

import { isRecord } from '../../kernel/contract-validation.ts';
import { sha256Text } from './agent-package-registry-parts/shared.ts';
import {
  discoverInstalledCodexPluginDescriptors,
  discoverInstalledOwnerProfileDescriptors,
} from './agent-package-registry-parts/installed-codex-plugin-directory.ts';
import type { AgentPackageManagedPolicyDependency } from './agent-package-registry-parts/types.ts';

export type FlowDependencyProjection = {
  dependency_id: string;
  dependency_kind: AgentPackageManagedPolicyDependency['kind'];
  activation: AgentPackageManagedPolicyDependency['activation'];
  offline_bundle: 'none' | 'full';
  online_install_default: boolean;
  source: string | null;
  lifecycle_owner: string;
  update_mode: 'silent_managed' | 'detect_only_guidance';
  observed_status: string | null;
  installed: boolean | null;
};

function readInstalledOwnerProfileDefault() {
  const descriptors = discoverInstalledOwnerProfileDescriptors();
  if (descriptors.length === 0) {
    return {
      surface_kind: 'opl_flow_default_user_instructions.v1' as const,
      source: 'installed_owner_descriptor' as const,
      source_path: null,
      source_root: null,
      package_version: null,
      status: 'unavailable' as const,
      reason: 'opl_flow_package_not_installed' as const,
      content: null,
      sha256: null,
    };
  }
  if (descriptors.length !== 1) {
    return {
      surface_kind: 'opl_flow_default_user_instructions.v1' as const,
      source: 'installed_owner_descriptor' as const,
      source_path: null,
      source_root: null,
      package_version: null,
      status: 'invalid' as const,
      reason: 'installed_owner_profile_descriptor_ambiguous' as const,
      content: null,
      sha256: null,
    };
  }

  const descriptor = descriptors[0]!;
  const sourceRoot = descriptor.sourcePath;
  const declaredSourcePath = descriptor.manifest.profile_surface!.runtime_profile.source_path;
  const base = {
    surface_kind: 'opl_flow_default_user_instructions.v1' as const,
    source: 'installed_owner_descriptor' as const,
    source_path: path.resolve(sourceRoot, declaredSourcePath),
    source_root: sourceRoot,
    package_version: descriptor.manifest.version,
  };
  try {
    const sourceRootRealPath = fs.realpathSync(sourceRoot);
    if (!fs.statSync(sourceRootRealPath).isDirectory()) {
      throw new Error('Installed owner descriptor source root is not a directory.');
    }
    const sourcePath = path.resolve(sourceRootRealPath, declaredSourcePath);
    const sourcePathRealPath = fs.realpathSync(sourcePath);
    if (!sourcePathRealPath.startsWith(`${sourceRootRealPath}${path.sep}`)
      || !fs.statSync(sourcePathRealPath).isFile()) {
      throw new Error('Installed owner profile source escaped its descriptor root.');
    }
    const content = fs.readFileSync(sourcePathRealPath, 'utf8');
    return {
      ...base,
      source_path: sourcePathRealPath,
      status: 'available' as const,
      reason: null,
      content,
      sha256: sha256Text(content),
    };
  } catch {
    return {
      ...base,
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

function readInstalledOplFlowManagedPolicyDependencies(): AgentPackageManagedPolicyDependency[] {
  const descriptor = discoverInstalledCodexPluginDescriptors().get('opl-flow');
  const policySurface = descriptor?.manifest.managed_policy_surface;
  if (!descriptor || !policySurface) return [];
  try {
    const sourceRoot = fs.realpathSync(descriptor.sourcePath);
    const policyPath = path.resolve(sourceRoot, policySurface.source_path);
    const policyRealPath = fs.realpathSync(policyPath);
    if (!policyRealPath.startsWith(`${sourceRoot}${path.sep}`)
      || !fs.statSync(policyRealPath).isFile()) {
      return [];
    }
    const policy = JSON.parse(fs.readFileSync(policyRealPath, 'utf8')) as unknown;
    if (!isRecord(policy) || !isRecord(policy.package) || policy.package.id !== 'opl-flow') return [];
    if (!Array.isArray(policy.requires)) return [];
    return policy.requires.flatMap((value) => {
      if (!isRecord(value) || typeof value.id !== 'string' || typeof value.kind !== 'string') return [];
      if (!['base', 'codex_skill', 'codex_plugin', 'mcp_server', 'cli', 'runtime_capability'].includes(value.kind)) {
        return [];
      }
      if (typeof value.online_install_default !== 'boolean'
        || typeof value.activation !== 'string'
        || !['always', 'task_routed', 'explicit'].includes(value.activation)) {
        return [];
      }
      return [{
        id: value.id,
        kind: value.kind as AgentPackageManagedPolicyDependency['kind'],
        offline_bundle: value.offline_bundle === 'full' ? 'full' : 'none',
        online_install_default: value.online_install_default,
        activation: value.activation as AgentPackageManagedPolicyDependency['activation'],
        source: typeof value.source === 'string' ? value.source : undefined,
        source_path: typeof value.source_path === 'string' ? value.source_path : undefined,
        owner: typeof value.owner === 'string' ? value.owner : undefined,
        version_requirement: typeof value.version_requirement === 'string' ? value.version_requirement : undefined,
        install_source: typeof value.install_source === 'string' ? value.install_source : undefined,
        lifecycle_owner: typeof value.lifecycle_owner === 'string' ? value.lifecycle_owner : undefined,
        conflict_policy: typeof value.conflict_policy === 'string'
          ? value.conflict_policy as AgentPackageManagedPolicyDependency['conflict_policy']
          : undefined,
        credential_policy: typeof value.credential_policy === 'string'
          ? value.credential_policy as AgentPackageManagedPolicyDependency['credential_policy']
          : undefined,
        relationship: 'required' as const,
      }];
    });
  } catch {
    return [];
  }
}

export function readOplFlowManagedDependencyIds() {
  return [...new Set(readInstalledOplFlowManagedPolicyDependencies().map((dependency) => dependency.id))];
}

export function readOplFlowManagedDependencies(): FlowDependencyProjection[] {
  return readInstalledOplFlowManagedPolicyDependencies().map((dependency) => ({
    dependency_id: dependency.id,
    dependency_kind: dependency.kind,
    activation: dependency.activation,
    offline_bundle: dependency.offline_bundle ?? 'none',
    online_install_default: dependency.online_install_default,
    source: dependency.source ?? null,
    lifecycle_owner: dependency.lifecycle_owner
      ?? (dependency.kind === 'codex_skill' ? 'opl_packages' : 'opl_base'),
    update_mode: dependency.online_install_default ? 'silent_managed' : 'detect_only_guidance',
    observed_status: null,
    installed: dependency.kind === 'base' ? true : null,
  }));
}
