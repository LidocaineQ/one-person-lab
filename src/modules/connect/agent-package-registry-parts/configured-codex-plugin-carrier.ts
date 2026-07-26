import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import { computePackageChannelTreeSha256 } from '../system-installation/module-package-channel.ts';
import type { AgentPackageConfiguredCodexPluginCarrierDescriptor } from './types.ts';

export type ConfiguredCodexPluginCarrierAction =
  | 'list'
  | 'install'
  | 'update'
  | 'repair'
  | 'remove';

type CodexPluginListEntry = {
  pluginId: string;
  version: string | null;
  installed: boolean;
  enabled: boolean;
  sourcePath: string | null;
  marketplaceSource: string | null;
};

export type ConfiguredCodexPluginCarrierObservedSource = {
  plugin_id: string;
  marketplace_source: string | null;
  installed_version: string | null;
  enabled: boolean;
  plugin_source_path: string | null;
  source_tree_sha256: string | null;
};

type CodexPluginCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
};

export type CodexPluginCommandRunner = (input: {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}) => CodexPluginCommandResult;

export type ConfiguredCodexPluginCarrierReadback = {
  surface_kind: 'opl_configured_codex_plugin_carrier_readback.v1';
  package_id: string;
  carrier: {
    kind: 'codex_plugin_manager';
    plugin_id: string;
    marketplace_source: string | null;
    observed_sources: ConfiguredCodexPluginCarrierObservedSource[];
    precedence:
      | 'exact_single_source'
      | 'ambiguous_same_plugin_name'
      | 'unexpected_same_plugin_name'
      | 'not_present'
      | 'unavailable';
  };
  executor: {
    route: 'codex_cli';
    required_skill_ids: string[];
    status: 'callable' | 'attention_needed';
  };
  publication_ref: string | null;
  status: 'installed' | 'not_installed' | 'physical_unavailable';
  installed_version: string | null;
  enabled: boolean | null;
  plugin_source_path: string | null;
  operation: ConfiguredCodexPluginCarrierAction;
  native_command: string[];
  native_action_dispatched: boolean;
  reason: string | null;
};

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function defaultRunner(input: {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): CodexPluginCommandResult {
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

function commandFailure(input: {
  packageId: string;
  action: ConfiguredCodexPluginCarrierAction;
  args: string[];
  result: CodexPluginCommandResult;
}): never {
  throw new FrameworkContractError(
    'contract_shape_invalid',
    'Configured Codex Plugin Manager action did not complete.',
    {
      package_id: input.packageId,
      action: input.action,
      command: input.args,
      exit_status: input.result.status,
      error: input.result.error?.message ?? null,
      stderr_present: Boolean(input.result.stderr.trim()),
      failure_code: input.result.error
        ? 'configured_codex_plugin_carrier_unavailable'
        : 'configured_codex_plugin_carrier_action_failed',
    },
  );
}

function parsePluginList(value: string, packageId: string): CodexPluginListEntry[] {
  const parsed = parseJsonText(value);
  const readback = isRecord(parsed) ? parsed : null;
  if (!readback || !Array.isArray(readback.installed)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Configured Codex Plugin Manager list readback has no installed array.',
      {
        package_id: packageId,
        failure_code: 'configured_codex_plugin_carrier_readback_invalid_shape',
      },
    );
  }
  return readback.installed.flatMap((value) => {
    const entry = isRecord(value) ? value : null;
    const pluginId = stringValue(entry?.pluginId);
    if (!entry || !pluginId) return [];
    const source = isRecord(entry.source) ? entry.source : null;
    const marketplaceSource = isRecord(entry.marketplaceSource) ? entry.marketplaceSource : null;
    return [{
      pluginId,
      version: stringValue(entry.version),
      installed: entry.installed === true,
      enabled: entry.enabled === true,
      sourcePath: stringValue(source?.path),
      marketplaceSource: stringValue(marketplaceSource?.source),
    }];
  });
}

function missingRequiredSkills(sourcePath: string | null, requiredSkillIds: string[]) {
  if (!sourcePath) return requiredSkillIds;
  return requiredSkillIds.filter((skillId) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skillId)) return true;
    const skillPath = path.join(sourcePath, 'skills', skillId, 'SKILL.md');
    try {
      return !fs.existsSync(skillPath) || !fs.statSync(skillPath).isFile();
    } catch {
      return true;
    }
  });
}

function pluginBareName(pluginId: string) {
  return pluginId.split('@', 1)[0] ?? pluginId;
}

function sourceTreeSha256(sourcePath: string | null) {
  if (!sourcePath) return null;
  try {
    return fs.statSync(sourcePath).isDirectory()
      ? computePackageChannelTreeSha256(sourcePath)
      : null;
  } catch {
    return null;
  }
}

function observedSource(entry: CodexPluginListEntry): ConfiguredCodexPluginCarrierObservedSource {
  return {
    plugin_id: entry.pluginId,
    marketplace_source: entry.marketplaceSource,
    installed_version: entry.version,
    enabled: entry.enabled,
    plugin_source_path: entry.sourcePath,
    source_tree_sha256: sourceTreeSha256(entry.sourcePath),
  };
}

function nativeArgs(action: ConfiguredCodexPluginCarrierAction, pluginId: string) {
  if (action === 'list') return ['plugin', 'list', '--json'];
  if (action === 'remove') return ['plugin', 'remove', pluginId, '--json'];
  return ['plugin', 'add', pluginId, '--json'];
}

function assertDescriptor(descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor) {
  if (!descriptor.packageId.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/
      .test(descriptor.carrier.pluginId)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Configured Codex Plugin Manager descriptor has an invalid identity or plugin selector.',
      {
        package_id: descriptor.packageId,
        plugin_id: descriptor.carrier.pluginId,
        failure_code: 'configured_codex_plugin_carrier_descriptor_invalid',
      },
    );
  }
}

function unavailableReadback(input: {
  descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor;
  action: ConfiguredCodexPluginCarrierAction;
  nativeCommand: string[];
  nativeActionDispatched: boolean;
  reason: string;
}): ConfiguredCodexPluginCarrierReadback {
  return {
    surface_kind: 'opl_configured_codex_plugin_carrier_readback.v1',
    package_id: input.descriptor.packageId,
    carrier: {
      kind: 'codex_plugin_manager',
      plugin_id: input.descriptor.carrier.pluginId,
      marketplace_source: null,
      observed_sources: [],
      precedence: 'unavailable',
    },
    executor: {
      route: input.descriptor.executor.route,
      required_skill_ids: [...input.descriptor.executor.requiredSkillIds],
      status: 'attention_needed',
    },
    publication_ref: input.descriptor.publicationRef,
    status: 'physical_unavailable',
    installed_version: null,
    enabled: null,
    plugin_source_path: null,
    operation: input.action,
    native_command: input.nativeCommand,
    native_action_dispatched: input.nativeActionDispatched,
    reason: input.reason,
  };
}

export function runConfiguredCodexPluginCarrier(input: {
  descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor;
  action: ConfiguredCodexPluginCarrierAction;
  dryRun?: boolean;
  binary?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CodexPluginCommandRunner;
}): ConfiguredCodexPluginCarrierReadback {
  assertDescriptor(input.descriptor);
  const binary = input.binary?.trim()
    || process.env.OPL_CODEX_PLUGIN_BIN?.trim()
    || 'codex';
  const runner = input.runner ?? defaultRunner;
  const env = { ...process.env, ...input.env };
  const actionArgs = nativeArgs(input.action, input.descriptor.carrier.pluginId);
  const dispatchAction = input.action !== 'list' && input.dryRun !== true;
  if (dispatchAction) {
    const actionResult = runner({ binary, args: actionArgs, env });
    if (actionResult.status !== 0 || actionResult.error) {
      commandFailure({
        packageId: input.descriptor.packageId,
        action: input.action,
        args: actionArgs,
        result: actionResult,
      });
    }
  }
  const listArgs = ['plugin', 'list', '--json'];
  const list = runner({ binary, args: listArgs, env });
  if (list.status !== 0 || list.error) {
    if (dispatchAction) {
      commandFailure({
        packageId: input.descriptor.packageId,
        action: input.action,
        args: listArgs,
        result: list,
      });
    }
    return unavailableReadback({
      descriptor: input.descriptor,
      action: input.action,
      nativeCommand: listArgs,
      nativeActionDispatched: input.action === 'list',
      reason: 'configured_native_carrier_unavailable',
    });
  }
  let entries: CodexPluginListEntry[];
  try {
    entries = parsePluginList(list.stdout, input.descriptor.packageId);
  } catch (error) {
    if (dispatchAction) throw error;
    return unavailableReadback({
      descriptor: input.descriptor,
      action: input.action,
      nativeCommand: listArgs,
      nativeActionDispatched: input.action === 'list',
      reason: error instanceof FrameworkContractError
        ? String(error.details?.failure_code ?? 'configured_native_carrier_readback_invalid')
        : 'configured_native_carrier_readback_invalid',
    });
  }
  const installedSameName = entries.filter(
    (candidate) => candidate.installed
      && pluginBareName(candidate.pluginId) === pluginBareName(input.descriptor.carrier.pluginId),
  );
  const entry = entries.find(
    (candidate) => candidate.pluginId === input.descriptor.carrier.pluginId,
  ) ?? null;
  const unexpectedSameName = installedSameName.filter(
    (candidate) => candidate.pluginId !== input.descriptor.carrier.pluginId,
  );
  const ambiguous = unexpectedSameName.length > 0 && Boolean(entry?.installed);
  const unexpectedOnly = !entry?.installed && unexpectedSameName.length > 0;
  const missingSkills = entry
    ? missingRequiredSkills(entry.sourcePath, input.descriptor.executor.requiredSkillIds)
    : input.descriptor.executor.requiredSkillIds;
  const callable = Boolean(
    entry?.installed
    && entry.enabled
    && missingSkills.length === 0
    && !ambiguous
    && !unexpectedOnly,
  );
  return {
    surface_kind: 'opl_configured_codex_plugin_carrier_readback.v1',
    package_id: input.descriptor.packageId,
    carrier: {
      kind: 'codex_plugin_manager',
      plugin_id: input.descriptor.carrier.pluginId,
      marketplace_source: ambiguous ? null : entry?.marketplaceSource ?? null,
      observed_sources: installedSameName.map(observedSource),
      precedence: ambiguous
        ? 'ambiguous_same_plugin_name'
        : unexpectedOnly
          ? 'unexpected_same_plugin_name'
        : entry?.installed
          ? 'exact_single_source'
          : 'not_present',
    },
    executor: {
      route: input.descriptor.executor.route,
      required_skill_ids: [...input.descriptor.executor.requiredSkillIds],
      status: callable ? 'callable' : 'attention_needed',
    },
    publication_ref: input.descriptor.publicationRef,
    status: entry?.installed
      ? 'installed'
      : unexpectedOnly
        ? 'not_installed'
        : 'physical_unavailable',
    installed_version: ambiguous ? null : entry?.version ?? null,
    enabled: entry?.installed ? entry.enabled : null,
    plugin_source_path: ambiguous ? null : entry?.sourcePath ?? null,
    operation: input.action,
    native_command: input.action === 'list' || input.dryRun === true ? listArgs : actionArgs,
    native_action_dispatched: input.action === 'list' || dispatchAction,
    reason: entry?.installed
      ? ambiguous
        ? 'configured_native_carrier_source_ambiguous'
        : (callable ? null : `required_skill_unavailable:${missingSkills.join(',')}`)
      : unexpectedOnly
        ? 'configured_native_carrier_unexpected_source_present'
      : 'native_carrier_reports_not_installed',
  };
}
