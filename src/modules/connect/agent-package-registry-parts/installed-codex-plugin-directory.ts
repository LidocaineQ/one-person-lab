import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
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

function readDescriptor(entry: InstalledPluginEntry): InstalledCodexPluginDescriptor | null {
  const manifestPath = path.join(entry.sourcePath, 'opl-package.json');
  try {
    if (!fs.statSync(manifestPath).isFile()) return null;
    const manifest = normalizePackageManifest(
      JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
      pathToFileURL(manifestPath).toString(),
    );
    const carrier: AgentPackageConfiguredCodexPluginCarrierDescriptor = {
      packageId: manifest.package_id,
      carrier: {
        kind: 'codex_plugin_manager',
        pluginId: entry.pluginId,
        marketplaceSource: entry.marketplaceSource,
      },
      executor: {
        route: 'codex_cli',
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
