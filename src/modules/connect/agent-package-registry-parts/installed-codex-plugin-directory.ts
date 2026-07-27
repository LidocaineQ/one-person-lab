import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import { canonicalAgentPackageId } from '../agent-package-identity.ts';
import { normalizePackageManifest } from './manifest-normalizers.ts';
import type {
  AgentPackageConfiguredCodexPluginCarrierDescriptor,
  AgentPackageManifest,
} from './types.ts';
import type {
  CodexPluginCommandRunner,
} from './configured-codex-plugin-carrier.ts';

type InstalledPluginEntry = {
  pluginId: string;
  version: string | null;
  enabled: boolean;
  sourcePath: string;
  marketplaceSource: string | null;
};

export type InstalledCodexPluginDescriptor = {
  manifest: AgentPackageManifest;
  manifestPath: string;
  sourcePath: string;
  pluginId: string;
  marketplaceSource: string | null;
  enabled: boolean;
  carrier: AgentPackageConfiguredCodexPluginCarrierDescriptor;
};

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseInstalledPlugins(value: string): InstalledPluginEntry[] {
  const parsed = parseJsonText(value);
  const readback = isRecord(parsed) ? parsed : null;
  if (!readback || !Array.isArray(readback.installed)) return [];
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

function pluginSkillIds(sourcePath: string, manifest: Record<string, unknown>) {
  const declared = manifest.skills;
  const roots = Array.isArray(declared)
    ? declared.filter((value): value is string => typeof value === 'string')
    : typeof declared === 'string'
      ? [declared]
      : ['./skills/'];
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

function normalizeInstalledPluginManifest(
  entry: InstalledPluginEntry,
  pluginPayload: Record<string, unknown>,
  manifestPath: string,
): AgentPackageManifest {
  const packageId = pluginPackageId(entry.pluginId);
  if (!packageId) throw new Error('plugin package id is empty');
  const interfacePayload = isRecord(pluginPayload.interface) ? pluginPayload.interface : {};
  const displayName = stringValue(interfacePayload.displayName)
    ?? stringValue(pluginPayload.name)
    ?? packageId;
  const description = stringValue(interfacePayload.longDescription)
    ?? stringValue(pluginPayload.description)
    ?? `${displayName} installed Codex plugin.`;
  const requiredSkillIds = pluginSkillIds(entry.sourcePath, pluginPayload);
  const sourceRepo = stringValue(pluginPayload.repository) ?? stringValue(pluginPayload.homepage);
  const version = entry.version
    ?? stringValue(pluginPayload.version)
    ?? '0.0.0';
  return {
    package_id: packageId,
    agent_id: packageId,
    package_role: 'standard_agent',
    display_name: displayName,
    publisher: stringValue(isRecord(pluginPayload.author) ? pluginPayload.author.name : null)
      ?? 'installed-plugin',
    version,
    owner_language_version: null,
    source: 'installed_descriptor',
    source_repo: sourceRepo,
    source_commit: null,
    carrier_source_commit: null,
    verified_payload_source_commit: null,
    codex_surface: {
      plugin_id: entry.pluginId,
      plugin_source_path: entry.sourcePath,
      required_skill_ids: requiredSkillIds,
      codex_default_exposure: entry.enabled,
    },
    codex_default_exposure: entry.enabled,
    skill_packs: [],
    entrypoints: [],
    health_check: {},
    permissions: [],
    distribution_payload: null,
    update_channel: 'codex_plugin_manager',
    // The native carrier owns lifecycle history. This is the existing explicit
    // no-rollback sentinel, not a locally manufactured rollback receipt.
    rollback_ref: `rollback-ref:${packageId}/unavailable`,
    codex_visible_entry: packageId,
    required_skill_ids: requiredSkillIds,
    optional_skill_refs: [],
    presentation: null,
    plugin_id: entry.pluginId,
    plugin_source_path: entry.sourcePath,
    plugin_payload_manifest_url: pathToFileURL(manifestPath).toString(),
    plugin_payload_manifest_sha256: null,
    plugin_payload_cache_path: null,
    profile_surface: null,
    managed_policy_surface: null,
    runtime_source_carrier: null,
    managed_update_source: null,
    capability_dependencies: [],
    capability_provider: null,
    content_digest: null,
    content_lock_canonicalization: null,
    content_lock_paths: [],
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

function readDescriptor(entry: InstalledPluginEntry): InstalledCodexPluginDescriptor | null {
  const ownerManifestPath = path.join(entry.sourcePath, 'opl-package.json');
  const pluginManifestPath = path.join(entry.sourcePath, '.codex-plugin', 'plugin.json');
  try {
    let manifestPath = ownerManifestPath;
    let manifest: AgentPackageManifest;
    if (fs.existsSync(ownerManifestPath) && fs.statSync(ownerManifestPath).isFile()) {
      manifest = normalizePackageManifest(
        JSON.parse(fs.readFileSync(ownerManifestPath, 'utf8')),
        pathToFileURL(ownerManifestPath).toString(),
      );
    } else {
      if (!fs.existsSync(pluginManifestPath) || !fs.statSync(pluginManifestPath).isFile()) return null;
      manifestPath = pluginManifestPath;
      const pluginPayload = JSON.parse(fs.readFileSync(pluginManifestPath, 'utf8'));
      if (!isRecord(pluginPayload)) return null;
      manifest = normalizeInstalledPluginManifest(entry, pluginPayload, pluginManifestPath);
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
    return {
      manifest,
      manifestPath,
      sourcePath: entry.sourcePath,
      pluginId: entry.pluginId,
      marketplaceSource: entry.marketplaceSource,
      enabled: entry.enabled,
      carrier,
    };
  } catch {
    return null;
  }
}

export function discoverInstalledCodexPluginDescriptors(input: {
  packageId?: string | null;
  binary?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CodexPluginCommandRunner;
} = {}) {
  const binary = input.binary?.trim() || process.env.OPL_CODEX_PLUGIN_BIN?.trim() || 'codex';
  const runner = input.runner ?? defaultRunner;
  const result = runner({
    binary,
    args: ['plugin', 'list', '--json'],
    env: { ...process.env, ...input.env },
  });
  if (result.status !== 0 || result.error) return new Map<string, InstalledCodexPluginDescriptor>();
  let entries: InstalledPluginEntry[];
  try {
    entries = parseInstalledPlugins(result.stdout);
  } catch {
    return new Map<string, InstalledCodexPluginDescriptor>();
  }
  const discovered = new Map<string, InstalledCodexPluginDescriptor>();
  for (const entry of entries) {
    const descriptor = readDescriptor(entry);
    if (!descriptor) continue;
    if (input.packageId && descriptor.manifest.package_id !== input.packageId) continue;
    if (discovered.has(descriptor.manifest.package_id)) continue;
    discovered.set(descriptor.manifest.package_id, descriptor);
  }
  return discovered;
}
