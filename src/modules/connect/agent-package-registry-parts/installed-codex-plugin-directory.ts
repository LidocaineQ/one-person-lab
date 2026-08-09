import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import {
  agentPluginOpenAiInterface,
  agentPluginSkillsRelativeRoot,
  resolveAgentPluginManifest,
  type ResolvedAgentPluginManifest,
} from '../../../kernel/agent-plugin-manifest.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import { canonicalAgentPackageId } from '../agent-package-identity.ts';
import { resolveFirstPartyPackageCatalog } from '../agent-package-first-party.ts';
import { normalizePackageManifest } from './manifest-normalizers.ts';
import { sha256Text } from './shared.ts';
import type {
  AgentPackageConfiguredCodexPluginCarrierDescriptor,
  AgentPackageManifest,
} from './types.ts';
import type {
  CodexPluginCommandRunner,
} from './configured-codex-plugin-carrier.ts';

export type InstalledCarrierEntry = {
  pluginId: string;
  version: string | null;
  enabled: boolean;
  sourcePath: string;
  sourceKind: string;
  marketplaceSource: string | null;
};

/**
 * Carrier-neutral installed readback.  This is deliberately a read model:
 * carrier lifecycle state is observed here, never recreated in Framework.
 */
export type InstalledPackageCarrierReadback = {
  kind: string;
  identity: string;
  source_ref: string;
  version: string | null;
  enabled: boolean;
  lifecycle_authority: 'carrier_owned';
};

export type InstalledPackageReadiness = {
  installed: boolean;
  physical_status: 'available' | 'unavailable';
  callability: 'callable' | 'disabled';
  projection_callability?: 'callable' | 'disabled';
};

export type InstalledPackageManifest = Pick<
  AgentPackageManifest,
  | 'package_id'
  | 'agent_id'
  | 'package_role'
  | 'display_name'
  | 'publisher'
  | 'version'
  | 'source'
  | 'source_repo'
  | 'codex_surface'
  | 'codex_default_exposure'
  | 'codex_visible_entry'
  | 'required_skill_ids'
  | 'optional_skill_refs'
  | 'presentation'
  | 'profile_surface'
  | 'managed_policy_surface'
  | 'capability_dependencies'
  | 'capability_provider'
  | 'configured_codex_plugin_carrier'
  | 'app_contributions'
> & Partial<Pick<AgentPackageManifest, 'content_digest'>>;

export type InstalledPackageDescriptor = {
  manifest: InstalledPackageManifest;
  manifestPath: string;
  manifest_sha256: string;
  sourcePath: string;
  pluginId: string;
  marketplaceSource: string | null;
  enabled: boolean;
  carrier: AgentPackageConfiguredCodexPluginCarrierDescriptor;
  /** Generic readback used by future carriers; `carrier` remains compatibility data. */
  carrier_readback: InstalledPackageCarrierReadback;
  readiness: InstalledPackageReadiness;
};

/** Compatibility alias for the Codex carrier adapter. */
export type InstalledCodexPluginDescriptor = InstalledPackageDescriptor;

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseInstalledCarrierEntries(
  value: string,
  packageId: string | null,
): InstalledCarrierEntry[] {
  const parsed = parseJsonText(value);
  const readback = isRecord(parsed) ? parsed : null;
  if (!readback || !Array.isArray(readback.installed)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Installed Codex Plugin Manager readback has no installed array.',
      {
        package_id: packageId,
        failure_code: 'configured_codex_plugin_carrier_readback_invalid_shape',
      },
    );
  }
  return readback.installed.flatMap((value) => {
    if (!isRecord(value)) return [];
    const pluginId = stringValue(value.pluginId);
    const source = isRecord(value.source) ? value.source : null;
    const sourcePath = stringValue(source?.path);
    if (!pluginId || !sourcePath || !path.isAbsolute(sourcePath)) return [];
    const marketplace = isRecord(value.marketplaceSource) ? value.marketplaceSource : null;
    return [{
      pluginId,
      version: stringValue(value.version),
      enabled: value.enabled === true,
      sourcePath,
      sourceKind: stringValue(source?.source) ?? 'codex_plugin_manager',
      marketplaceSource: stringValue(marketplace?.source),
    }];
  });
}

function defaultRunner(input: {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}) {
  const result = spawnSync(input.binary, input.args, {
    encoding: 'utf8',
    env: input.env,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

function pluginPackageId(pluginId: string) {
  const bareName = pluginId.split('@', 1)[0]?.trim().toLowerCase() ?? '';
  const normalized = bareName.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return canonicalAgentPackageId(normalized) ?? normalized;
}

function pluginSkillIds(sourcePath: string, resolved: ResolvedAgentPluginManifest) {
  const declared = resolved.manifest.skills;
  const roots = resolved.kind === 'agent_plugins_1_0'
    ? [agentPluginSkillsRelativeRoot(resolved)]
    : Array.isArray(declared)
      ? declared.filter((value): value is string => typeof value === 'string')
      : [agentPluginSkillsRelativeRoot(resolved)];
  const skillIds = new Set<string>();
  for (const root of roots) {
    if (!root.trim() || root.startsWith('/') || root.includes('\0')) continue;
    const skillRoot = path.resolve(sourcePath, root);
    if (skillRoot !== sourcePath && !skillRoot.startsWith(`${path.resolve(sourcePath)}${path.sep}`)) continue;
    try {
      for (const entry of fs.readdirSync(skillRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(skillRoot, entry.name, 'SKILL.md');
        if (fs.statSync(skillFile).isFile()) skillIds.add(entry.name);
      }
    } catch {
      // An installed plugin may expose tools or commands without a Skill directory.
    }
  }
  return [...skillIds].sort();
}

function normalizeNativeCarrierManifest(
  entry: InstalledCarrierEntry,
  resolved: ResolvedAgentPluginManifest,
): InstalledPackageManifest {
  const pluginPayload = resolved.manifest;
  const packageId = pluginPackageId(entry.pluginId);
  if (!packageId) throw new Error('plugin package id is empty');
  const interfacePayload = agentPluginOpenAiInterface(pluginPayload) ?? {};
  const displayName = stringValue(interfacePayload.displayName)
    ?? stringValue(pluginPayload.name)
    ?? packageId;
  const requiredSkillIds = pluginSkillIds(entry.sourcePath, resolved);
  const sourceRepo = stringValue(pluginPayload.repository) ?? stringValue(pluginPayload.homepage);
  const version = entry.version
    ?? stringValue(pluginPayload.version)
    ?? '0.0.0';
  return {
    package_id: packageId,
    agent_id: null,
    package_role: 'standard_agent',
    display_name: displayName,
    publisher: stringValue(isRecord(pluginPayload.author) ? pluginPayload.author.name : null)
      ?? 'installed-plugin',
    version,
    source: 'installed_descriptor',
    source_repo: sourceRepo,
    codex_surface: {
      plugin_id: entry.pluginId,
      plugin_source_path: entry.sourcePath,
      required_skill_ids: requiredSkillIds,
      codex_default_exposure: entry.enabled,
    },
    codex_default_exposure: entry.enabled,
    codex_visible_entry: packageId,
    required_skill_ids: requiredSkillIds,
    optional_skill_refs: [],
    presentation: null,
    profile_surface: null,
    managed_policy_surface: null,
    capability_dependencies: [],
    capability_provider: null,
    configured_codex_plugin_carrier: {
      packageId,
      carrier: {
        kind: 'codex_plugin_manager',
        pluginId: entry.pluginId,
        marketplaceSource: entry.marketplaceSource,
      },
      executor: {
        route: 'codex_cli',
        requiredSkillIds: [...requiredSkillIds],
      },
      publicationRef: null,
    },
    app_contributions: null,
  };
}

function readInstalledPackageDescriptor(entry: InstalledCarrierEntry): InstalledPackageDescriptor | null {
  const ownerManifestPath = path.join(entry.sourcePath, 'opl-package.json');
  try {
    let manifestPath = ownerManifestPath;
    let manifest: InstalledPackageManifest;
    let manifestText: string;
    if (fs.existsSync(ownerManifestPath) && fs.statSync(ownerManifestPath).isFile()) {
      manifestText = fs.readFileSync(ownerManifestPath, 'utf8');
      manifest = normalizePackageManifest(
        JSON.parse(manifestText),
        pathToFileURL(ownerManifestPath).toString(),
      );
    } else {
      const resolvedPlugin = resolveAgentPluginManifest([entry.sourcePath]);
      if (!resolvedPlugin) return null;
      manifestPath = resolvedPlugin.manifestPath;
      manifestText = fs.readFileSync(manifestPath, 'utf8');
      manifest = normalizeNativeCarrierManifest(entry, resolvedPlugin);
      // First-party Package identity remains owned by its stable catalog. A
      // carrier-native manifest without an explicit Framework owner descriptor
      // must not synthesize a second authority for that identity.
      if (resolveFirstPartyPackageCatalog(manifest.package_id)) return null;
    }
    const carrier = manifest.configured_codex_plugin_carrier
      ?? {
        packageId: manifest.package_id,
        carrier: {
          kind: 'codex_plugin_manager' as const,
          pluginId: entry.pluginId,
          marketplaceSource: entry.marketplaceSource,
        },
        executor: {
          route: 'codex_cli' as const,
          requiredSkillIds: [...manifest.required_skill_ids],
        },
        publicationRef: null,
      };
    const projectionCallableWhileDisabled = manifest.package_role === 'capability_package'
      && manifest.codex_default_exposure === false;
    return {
      manifest,
      manifestPath,
      manifest_sha256: sha256Text(manifestText),
      sourcePath: entry.sourcePath,
      pluginId: entry.pluginId,
      marketplaceSource: entry.marketplaceSource,
      enabled: entry.enabled,
      carrier,
      carrier_readback: {
        kind: entry.sourceKind,
        identity: entry.pluginId,
        source_ref: entry.sourcePath,
        version: entry.version ?? manifest.version,
        enabled: entry.enabled,
        lifecycle_authority: 'carrier_owned',
      },
      readiness: {
        installed: true,
        physical_status: fs.existsSync(entry.sourcePath) ? 'available' : 'unavailable',
        callability: entry.enabled ? 'callable' : 'disabled',
        ...(projectionCallableWhileDisabled
          ? { projection_callability: 'callable' as const }
          : {}),
      },
    };
  } catch {
    return null;
  }
}

export function discoverInstalledPackageDescriptors(input: {
  packageId?: string | null;
  binary?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CodexPluginCommandRunner;
  failClosedOnCarrierError?: boolean;
} = {}) {
  const entries = readInstalledCarrierEntries(input);
  const discovered = new Map<string, InstalledPackageDescriptor>();
  for (const entry of entries) {
    const descriptor = readInstalledPackageDescriptor(entry);
    if (!descriptor) continue;
    if (input.packageId && descriptor.manifest.package_id !== input.packageId) continue;
    const previous = discovered.get(descriptor.manifest.package_id);
    if (previous && (previous.enabled || !descriptor.enabled)) continue;
    discovered.set(descriptor.manifest.package_id, descriptor);
  }
  return discovered;
}

export function readInstalledCarrierEntries(input: {
  packageId?: string | null;
  binary?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CodexPluginCommandRunner;
  failClosedOnCarrierError?: boolean;
} = {}) {
  const configuredBinary = input.binary?.trim() || process.env.OPL_CODEX_PLUGIN_BIN?.trim() || null;
  const binary = configuredBinary ?? 'codex';
  const runner = input.runner ?? defaultRunner;
  const result = runner({
    binary,
    args: ['plugin', 'list', '--json'],
    env: { ...process.env, ...input.env },
  });
  if (result.status !== 0 || result.error) {
    const defaultCarrierAbsent = !configuredBinary
      && (result.error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
    if (defaultCarrierAbsent) {
      return [];
    }
    if (input.failClosedOnCarrierError) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Installed Codex Plugin Manager discovery did not complete.',
        {
          package_id: input.packageId ?? null,
          action: 'list',
          command: ['plugin', 'list', '--json'],
          exit_status: result.status,
          error: result.error?.message ?? null,
          stderr_present: Boolean(result.stderr.trim()),
          failure_code: result.error
            ? 'configured_codex_plugin_carrier_unavailable'
            : 'configured_codex_plugin_carrier_action_failed',
        },
      );
    }
    return [];
  }
  let entries: InstalledCarrierEntry[];
  try {
    entries = parseInstalledCarrierEntries(result.stdout, input.packageId ?? null);
  } catch (error) {
    if (input.failClosedOnCarrierError) {
      if (error instanceof FrameworkContractError) throw error;
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Installed Codex Plugin Manager discovery readback is invalid.',
        {
          package_id: input.packageId ?? null,
          failure_code: 'configured_codex_plugin_carrier_readback_invalid_shape',
        },
      );
    }
    return [];
  }
  return entries;
}

/**
 * Profile defaults are owned by an installed first-party Package descriptor.
 * A carrier-native Agent Plugin manifest is not sufficient authority to
 * replace user instructions, even when it presents a similar plugin surface.
 */
export function discoverInstalledOwnerProfileDescriptors(input: {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CodexPluginCommandRunner;
} = {}) {
  return [...discoverInstalledPackageDescriptors(input).values()]
    .filter((descriptor) => (
      descriptor.manifest.source === 'first_party'
      && descriptor.manifestPath === path.join(descriptor.sourcePath, 'opl-package.json')
      && descriptor.manifest.profile_surface?.runtime_profile.target_id === 'user_agents_profile'
    ))
    .sort((left, right) => left.manifest.package_id.localeCompare(right.manifest.package_id));
}

/**
 * Codex remains one native carrier adapter. Keep its historical export while
 * making the installed descriptor producer explicit and carrier-neutral.
 */
export const discoverInstalledCodexPluginDescriptors = discoverInstalledPackageDescriptors;
