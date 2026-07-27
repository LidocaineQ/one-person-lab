import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import { computePackageChannelTreeSha256 } from '../system-installation/module-package-channel.ts';
import {
  parseTomlDocument,
  renderTomlDocument,
} from './managed-policy-surface.ts';
import type { AgentPackageConfiguredCodexPluginCarrierDescriptor } from './types.ts';

export type ConfiguredCodexPluginCarrierAction =
  | 'list'
  | 'install'
  | 'update'
  | 'repair'
  | 'remove'
  | 'enable'
  | 'disable';

type CodexPluginListEntry = {
  pluginId: string;
  version: string | null;
  installed: boolean;
  enabled: boolean;
  sourcePath: string | null;
  marketplaceSource: string | null;
};

type CodexPluginMarketplaceListEntry = {
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

function marketplaceListEntry(value: unknown): CodexPluginMarketplaceListEntry | null {
  if (!isRecord(value)) return null;
  const marketplaceSource = isRecord(value.marketplaceSource) ? value.marketplaceSource : null;
  return { marketplaceSource: stringValue(marketplaceSource?.source) };
}

function parseMarketplaceList(value: string, packageId: string): CodexPluginMarketplaceListEntry[] {
  const parsed = parseJsonText(value);
  const readback = isRecord(parsed) ? parsed : null;
  if (!readback || !Array.isArray(readback.marketplaces)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Configured Codex Plugin Manager marketplace readback has no marketplaces array.',
      {
        package_id: packageId,
        failure_code: 'configured_codex_plugin_carrier_marketplace_readback_invalid_shape',
      },
    );
  }
  return readback.marketplaces
    .map(marketplaceListEntry)
    .filter((entry): entry is CodexPluginMarketplaceListEntry => entry !== null);
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
  if (action === 'enable' || action === 'disable') return ['plugin', 'list', '--json'];
  return ['plugin', 'add', pluginId, '--json'];
}

function configuredCodexHome(env: NodeJS.ProcessEnv) {
  const configured = env.CODEX_HOME?.trim();
  if (configured) return path.resolve(configured);
  const home = env.HOME?.trim() || os.homedir();
  return path.join(path.resolve(home), '.codex');
}

function replacePluginEnabledTable(input: {
  configPath: string;
  pluginId: string;
  enabled: boolean;
}) {
  const before = fs.existsSync(input.configPath)
    ? fs.readFileSync(input.configPath, 'utf8')
    : '';
  const expectedHeader = `plugins.${input.pluginId}`;
  const document = parseTomlDocument(before);
  const target = document.tables.find((table) => table.header === expectedHeader) ?? null;
  const enabledLine = `enabled = ${input.enabled ? 'true' : 'false'}`;
  const tables = target
    ? document.tables.map((table) => {
      if (table !== target) return table;
      const lines = table.content.trimEnd().split('\n');
      const enabledIndexes = lines.flatMap((line, index) => /^\s*enabled\s*=/.test(line) ? [index] : []);
      if (enabledIndexes.length > 1) {
        throw new FrameworkContractError(
          'contract_shape_invalid',
          'Configured Codex plugin table has duplicate enabled keys.',
          {
            plugin_id: input.pluginId,
            config_path: input.configPath,
            failure_code: 'configured_codex_plugin_carrier_config_duplicate_enabled',
          },
        );
      }
      if (enabledIndexes.length === 1) lines[enabledIndexes[0]] = enabledLine;
      else lines.push(enabledLine);
      return { content: `${lines.join('\n').trimEnd()}\n` };
    })
    : [
      ...document.tables,
      { content: `[plugins."${input.pluginId}"]\n${enabledLine}\n` },
    ];
  const after = renderTomlDocument(document.preamble, tables);
  if (after === before) return false;
  fs.mkdirSync(path.dirname(input.configPath), { recursive: true });
  const temporary = path.join(
    path.dirname(input.configPath),
    `.${path.basename(input.configPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, after, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, input.configPath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return true;
}

function setConfiguredPluginEnabled(input: {
  descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor;
  entries: CodexPluginListEntry[];
  enabled: boolean;
  env: NodeJS.ProcessEnv;
}) {
  const selection = configuredPluginSelection({
    entries: input.entries,
    descriptor: input.descriptor,
  });
  if (!selection.entry?.installed || selection.ambiguous || selection.unexpectedOnly) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Configured Codex plugin toggle requires one exact installed native carrier source.',
      {
        package_id: input.descriptor.packageId,
        plugin_id: input.descriptor.carrier.pluginId,
        precedence: configuredCarrierPrecedence({
          ambiguous: selection.ambiguous,
          unexpectedOnly: selection.unexpectedOnly,
          installed: Boolean(selection.entry?.installed),
        }),
        failure_code: 'configured_codex_plugin_carrier_toggle_requires_exact_installed_source',
      },
    );
  }
  return replacePluginEnabledTable({
    configPath: path.join(configuredCodexHome(input.env), 'config.toml'),
    pluginId: input.descriptor.carrier.pluginId,
    enabled: input.enabled,
  });
}

function ensureMarketplaceArgs(source: string) {
  return ['plugin', 'marketplace', 'add', source, '--json'];
}

function ensureMarketplaceAvailable(input: {
  packageId: string;
  action: ConfiguredCodexPluginCarrierAction;
  marketplaceSource: string;
  binary: string;
  env: NodeJS.ProcessEnv;
  runner: CodexPluginCommandRunner;
}) {
  const marketplaceListArgs = ['plugin', 'marketplace', 'list', '--json'];
  const marketplaceList = input.runner({
    binary: input.binary,
    args: marketplaceListArgs,
    env: input.env,
  });
  const marketplacePresent = marketplaceList.status === 0 && !marketplaceList.error
    ? parseMarketplaceList(marketplaceList.stdout, input.packageId)
      .some((entry) => entry.marketplaceSource === input.marketplaceSource)
    : false;
  if (marketplacePresent) return;

  const marketplaceArgs = ensureMarketplaceArgs(input.marketplaceSource);
  const marketplaceResult = input.runner({
    binary: input.binary,
    args: marketplaceArgs,
    env: input.env,
  });
  if (marketplaceResult.status !== 0 || marketplaceResult.error) {
    commandFailure({
      packageId: input.packageId,
      action: input.action,
      args: marketplaceArgs,
      result: marketplaceResult,
    });
  }
}

function assertDescriptor(descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor) {
  if (!descriptor.packageId.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/
      .test(descriptor.carrier.pluginId)
    || (descriptor.carrier.marketplaceSource !== null
      && (!descriptor.carrier.marketplaceSource.trim()
        || descriptor.carrier.marketplaceSource.startsWith('-')
        || descriptor.carrier.marketplaceSource.includes('\0')))) {
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

function dispatchConfiguredPluginAction(input: {
  dispatchAction: boolean;
  packageId: string;
  action: ConfiguredCodexPluginCarrierAction;
  actionArgs: string[];
  binary: string;
  env: NodeJS.ProcessEnv;
  runner: CodexPluginCommandRunner;
}) {
  if (!input.dispatchAction) return;
  const actionResult = input.runner({
    binary: input.binary,
    args: input.actionArgs,
    env: input.env,
  });
  if (actionResult.status !== 0 || actionResult.error) {
    commandFailure({
      packageId: input.packageId,
      action: input.action,
      args: input.actionArgs,
      result: actionResult,
    });
  }
}

function listUnavailableReadback(input: {
  descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor;
  action: ConfiguredCodexPluginCarrierAction;
  listArgs: string[];
  dispatchAction: boolean;
}): ConfiguredCodexPluginCarrierReadback {
  return unavailableReadback({
    descriptor: input.descriptor,
    action: input.action,
    nativeCommand: input.listArgs,
    nativeActionDispatched: input.action === 'list',
    reason: 'configured_native_carrier_unavailable',
  });
}

function invalidListReadback(input: {
  descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor;
  action: ConfiguredCodexPluginCarrierAction;
  listArgs: string[];
  error: unknown;
}): ConfiguredCodexPluginCarrierReadback {
  return unavailableReadback({
    descriptor: input.descriptor,
    action: input.action,
    nativeCommand: input.listArgs,
    nativeActionDispatched: input.action === 'list',
    reason: input.error instanceof FrameworkContractError
      ? String(input.error.details?.failure_code ?? 'configured_native_carrier_readback_invalid')
      : 'configured_native_carrier_readback_invalid',
  });
}

function readConfiguredPluginEntries(input: {
  descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor;
  action: ConfiguredCodexPluginCarrierAction;
  dispatchAction: boolean;
  binary: string;
  env: NodeJS.ProcessEnv;
  runner: CodexPluginCommandRunner;
}): CodexPluginListEntry[] | ConfiguredCodexPluginCarrierReadback {
  const listArgs = ['plugin', 'list', '--json'];
  const list = input.runner({ binary: input.binary, args: listArgs, env: input.env });
  if (list.status !== 0 || list.error) {
    if (input.dispatchAction) {
      commandFailure({
        packageId: input.descriptor.packageId,
        action: input.action,
        args: listArgs,
        result: list,
      });
    }
    return listUnavailableReadback({
      descriptor: input.descriptor,
      action: input.action,
      listArgs,
      dispatchAction: input.dispatchAction,
    });
  }
  try {
    return parsePluginList(list.stdout, input.descriptor.packageId);
  } catch (error) {
    if (input.dispatchAction) throw error;
    return invalidListReadback({
      descriptor: input.descriptor,
      action: input.action,
      listArgs,
      error,
    });
  }
}

function isConfiguredCarrierReadback(
  value: CodexPluginListEntry[] | ConfiguredCodexPluginCarrierReadback,
): value is ConfiguredCodexPluginCarrierReadback {
  return !Array.isArray(value);
}

function configuredPluginSelection(input: {
  entries: CodexPluginListEntry[];
  descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor;
}) {
  const pluginId = input.descriptor.carrier.pluginId;
  const installedSameName = input.entries.filter(
    (candidate) => candidate.installed && pluginBareName(candidate.pluginId) === pluginBareName(pluginId),
  );
  const entry = input.entries.find((candidate) => candidate.pluginId === pluginId) ?? null;
  const unexpectedSameName = installedSameName.filter((candidate) => candidate.pluginId !== pluginId);
  const ambiguous = unexpectedSameName.length > 0 && Boolean(entry?.installed);
  const unexpectedOnly = !entry?.installed && unexpectedSameName.length > 0;
  const missingSkills = entry
    ? missingRequiredSkills(entry.sourcePath, input.descriptor.executor.requiredSkillIds)
    : input.descriptor.executor.requiredSkillIds;
  const callable = Boolean(entry?.installed && entry.enabled && missingSkills.length === 0 && !ambiguous && !unexpectedOnly);
  return { installedSameName, entry, ambiguous, unexpectedOnly, missingSkills, callable };
}

function configuredCarrierPrecedence(input: { ambiguous: boolean; unexpectedOnly: boolean; installed: boolean }) {
  if (input.ambiguous) return 'ambiguous_same_plugin_name' as const;
  if (input.unexpectedOnly) return 'unexpected_same_plugin_name' as const;
  return input.installed ? 'exact_single_source' as const : 'not_present' as const;
}

function configuredCarrierReason(input: {
  installed: boolean;
  ambiguous: boolean;
  unexpectedOnly: boolean;
  callable: boolean;
  enabled: boolean;
  missingSkills: string[];
}) {
  if (input.installed) {
    if (input.ambiguous) return 'configured_native_carrier_source_ambiguous';
    if (!input.enabled) return 'configured_native_carrier_disabled';
    return input.callable ? null : `required_skill_unavailable:${input.missingSkills.join(',')}`;
  }
  return input.unexpectedOnly
    ? 'configured_native_carrier_unexpected_source_present'
    : 'native_carrier_reports_not_installed';
}

function configuredPluginReadback(input: {
  descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor;
  action: ConfiguredCodexPluginCarrierAction;
  dryRun: boolean | undefined;
  dispatchAction: boolean;
  actionArgs: string[];
  entries: CodexPluginListEntry[];
}): ConfiguredCodexPluginCarrierReadback {
  const selection = configuredPluginSelection({ entries: input.entries, descriptor: input.descriptor });
  const installed = Boolean(selection.entry?.installed);
  return {
    surface_kind: 'opl_configured_codex_plugin_carrier_readback.v1',
    package_id: input.descriptor.packageId,
    carrier: {
      kind: 'codex_plugin_manager',
      plugin_id: input.descriptor.carrier.pluginId,
      marketplace_source: selection.ambiguous ? null : selection.entry?.marketplaceSource ?? null,
      observed_sources: selection.installedSameName.map(observedSource),
      precedence: configuredCarrierPrecedence({
        ambiguous: selection.ambiguous,
        unexpectedOnly: selection.unexpectedOnly,
        installed,
      }),
    },
    executor: {
      route: input.descriptor.executor.route,
      required_skill_ids: [...input.descriptor.executor.requiredSkillIds],
      status: selection.callable ? 'callable' : 'attention_needed',
    },
    publication_ref: input.descriptor.publicationRef,
    status: installed ? 'installed' : selection.unexpectedOnly ? 'not_installed' : 'physical_unavailable',
    installed_version: selection.ambiguous ? null : selection.entry?.version ?? null,
    enabled: installed ? selection.entry?.enabled ?? false : null,
    plugin_source_path: selection.ambiguous ? null : selection.entry?.sourcePath ?? null,
    operation: input.action,
    native_command: input.action === 'list' || input.dryRun === true
      ? ['plugin', 'list', '--json']
      : input.actionArgs,
    native_action_dispatched: input.action === 'list' || input.dispatchAction,
    reason: configuredCarrierReason({
      installed,
      ambiguous: selection.ambiguous,
      unexpectedOnly: selection.unexpectedOnly,
      callable: selection.callable,
      enabled: selection.entry?.enabled === true,
      missingSkills: selection.missingSkills,
    }),
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
  const isConfigToggle = input.action === 'enable' || input.action === 'disable';
  const dispatchAction = !isConfigToggle && input.action !== 'list' && input.dryRun !== true;
  const marketplaceSource = input.descriptor.carrier.marketplaceSource;
  if (dispatchAction && marketplaceSource) {
    ensureMarketplaceAvailable({
      packageId: input.descriptor.packageId,
      action: input.action,
      marketplaceSource,
      binary,
      env,
      runner,
    });
  }
  dispatchConfiguredPluginAction({
    dispatchAction,
    packageId: input.descriptor.packageId,
    action: input.action,
    actionArgs,
    binary,
    env,
    runner,
  });
  let entries = readConfiguredPluginEntries({
    descriptor: input.descriptor,
    action: input.action,
    dispatchAction,
    binary,
    env,
    runner,
  });
  if (isConfiguredCarrierReadback(entries)) return entries;
  if (isConfigToggle && input.dryRun !== true) {
    setConfiguredPluginEnabled({
      descriptor: input.descriptor,
      entries,
      enabled: input.action === 'enable',
      env,
    });
    entries = readConfiguredPluginEntries({
      descriptor: input.descriptor,
      action: input.action,
      dispatchAction: true,
      binary,
      env,
      runner,
    });
    if (isConfiguredCarrierReadback(entries)) return entries;
  }
  return configuredPluginReadback({
    descriptor: input.descriptor,
    action: input.action,
    dryRun: input.dryRun,
    dispatchAction,
    actionArgs,
    entries,
  });
}
