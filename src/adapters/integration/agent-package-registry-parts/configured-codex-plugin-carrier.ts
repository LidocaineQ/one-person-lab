import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import {
  agentPluginSkillsRelativeRoot,
  resolveAgentPluginManifest,
} from '../../../kernel/agent-plugin-manifest.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import {
  listCurrentPackageProjections,
  PACKAGE_PROJECTION_ROOT,
} from '../../../kernel/standard-agent-registry.ts';
import { resolveCanonicalOplFamilyMarketplaceId } from '../system-installation/codex-plugin-registry.ts';
import { PACKAGED_MODULE_MARKER_FILE } from '../packaged-module-marker.ts';
import {
  parseTomlDocument,
  renderTomlDocument,
} from './managed-policy-surface.ts';
import {
  githubMarketplaceSourceIdentity,
  sameMarketplaceSource,
} from './shared.ts';
import type { AgentPackageConfiguredCodexPluginCarrierDescriptor } from './types.ts';

export { githubMarketplaceSourceIdentity } from './shared.ts';

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
  name: string | null;
  sourceType: string | null;
  marketplaceSource: string | null;
};

type TomlTable = ReturnType<typeof parseTomlDocument>['tables'][number];

export type ConfiguredCodexPluginCarrierObservedSource = {
  plugin_id: string;
  marketplace_source: string | null;
  installed_version: string | null;
  enabled: boolean;
  plugin_source_path: string | null;
  source_tree_sha256: string | null;
};

export type CodexPluginCommandResult = {
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

export function createMemoizedCodexPluginListRunner(
  runner: CodexPluginCommandRunner = defaultRunner,
): CodexPluginCommandRunner {
  let pluginListReadback: CodexPluginCommandResult | undefined;
  return (input) => {
    if (input.args.length === 3
      && input.args[0] === 'plugin'
      && input.args[1] === 'list'
      && input.args[2] === '--json') {
      pluginListReadback ??= runner(input);
      return pluginListReadback;
    }
    return runner(input);
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
  return {
    name: stringValue(value.name),
    sourceType: stringValue(marketplaceSource?.sourceType),
    marketplaceSource: stringValue(marketplaceSource?.source),
  };
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

function realDirectory(candidatePath: string) {
  const resolved = path.resolve(candidatePath);
  try {
    const stat = fs.lstatSync(resolved);
    return stat.isDirectory() && !stat.isSymbolicLink()
      ? fs.realpathSync(resolved)
      : null;
  } catch {
    return null;
  }
}

function safeRelativeDirectory(rootPath: string, rootReal: string, relativePath: string) {
  if (path.isAbsolute(relativePath)) return null;
  const resolved = path.resolve(rootPath, relativePath);
  const relative = path.relative(rootPath, resolved);
  try {
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    let current = rootPath;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    }
    const real = fs.realpathSync(resolved);
    return real === rootReal || real.startsWith(`${rootReal}${path.sep}`) ? resolved : null;
  } catch {
    return null;
  }
}

function pluginSkillsRef(sourceRoot: string, sourceRootReal: string) {
  try {
    const resolved = resolveAgentPluginManifest([sourceRoot]);
    if (!resolved || resolved.pluginRoot !== sourceRoot) return null;
    return agentPluginSkillsRelativeRoot(resolved);
  } catch {
    return null;
  }
}

function safePluginSkillsRoot(sourcePath: string | null) {
  if (!sourcePath) return null;
  const sourceRoot = path.resolve(sourcePath);
  const sourceRootReal = realDirectory(sourceRoot);
  if (!sourceRootReal) return null;
  const relativeSkillsRoot = pluginSkillsRef(sourceRoot, sourceRootReal);
  return relativeSkillsRoot
    ? safeRelativeDirectory(sourceRoot, sourceRootReal, relativeSkillsRoot)
    : null;
}

function isSafeRequiredSkillFile(skillsRoot: string, skillsRootReal: string, skillId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skillId)) return false;
  const skillDirectory = path.join(skillsRoot, skillId);
  const skillPath = path.join(skillDirectory, 'SKILL.md');
  try {
    const skillDirectoryStat = fs.lstatSync(skillDirectory);
    const skillStat = fs.lstatSync(skillPath);
    const skillReal = fs.realpathSync(skillPath);
    return skillDirectoryStat.isDirectory() && !skillDirectoryStat.isSymbolicLink()
      && skillStat.isFile() && !skillStat.isSymbolicLink()
      && skillReal.startsWith(`${skillsRootReal}${path.sep}`);
  } catch {
    return false;
  }
}

function missingRequiredSkills(sourcePath: string | null, requiredSkillIds: string[]) {
  const skillsRoot = safePluginSkillsRoot(sourcePath);
  if (!skillsRoot) return requiredSkillIds;
  const skillsRootReal = fs.realpathSync(skillsRoot);
  return requiredSkillIds.filter(
    (skillId) => !isSafeRequiredSkillFile(skillsRoot, skillsRootReal, skillId),
  );
}

function pluginBareName(pluginId: string) {
  return pluginId.split('@', 1)[0] ?? pluginId;
}

function sourceTreeSha256(sourcePath: string | null) {
  if (!sourcePath) return null;
  try {
    if (!fs.statSync(sourcePath).isDirectory()) return null;
    const hash = crypto.createHash('sha256');
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        const absolutePath = path.join(directory, entry.name);
        const relativePath = path.relative(sourcePath, absolutePath).split(path.sep).join('/');
        if (relativePath === PACKAGED_MODULE_MARKER_FILE || (entry.isDirectory() && entry.name === '__pycache__')) continue;
        const stat = fs.lstatSync(absolutePath);
        const mode = (stat.mode & 0o777).toString(8);
        if (entry.isDirectory()) {
          hash.update(`dir\0${relativePath}\0${mode}\0`);
          visit(absolutePath);
        } else if (entry.isSymbolicLink()) {
          hash.update(`symlink\0${relativePath}\0${mode}\0${fs.readlinkSync(absolutePath)}\0`);
        } else if (entry.isFile()) {
          const fileHash = crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
          hash.update(`file\0${relativePath}\0${mode}\0${fileHash}\0`);
        }
      }
    };
    visit(sourcePath);
    return hash.digest('hex');
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

function localReadbackFailure(failureCode: string, message: string, details: Record<string, unknown> = {}): never {
  throw new FrameworkContractError('contract_shape_invalid', message, { ...details, failure_code: failureCode });
}

function tomlTableValue(table: TomlTable, key: string, required: boolean) {
  const matches = table.content.split('\n').slice(1).flatMap((line) => {
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
    return match ? [match[1]] : [];
  });
  if (matches.length > 1 || (required && matches.length !== 1)) {
    localReadbackFailure('configured_codex_plugin_carrier_local_config_invalid',
      'Configured Codex local carrier table has a missing or duplicate required key.', {
        table: table.header, key, value_count: matches.length,
      });
  }
  return matches[0] ?? null;
}

function tomlStringValue(table: TomlTable, key: string) {
  const raw = tomlTableValue(table, key, true)!;
  try {
    const parsed = parseJsonText(raw);
    if (typeof parsed === 'string' && parsed.trim()) return parsed;
  } catch {
    // The owner-generated local carrier uses TOML basic strings compatible with JSON string syntax.
  }
  return localReadbackFailure(
    'configured_codex_plugin_carrier_local_config_invalid',
    'Configured Codex local carrier string is invalid.',
    { table: table.header, key },
  );
}

function tomlEnabledValue(table: TomlTable) {
  const raw = tomlTableValue(table, 'enabled', false);
  if (raw === null || raw === 'true') return true;
  if (raw === 'false') return false;
  return localReadbackFailure(
    'configured_codex_plugin_carrier_local_config_invalid',
    'Configured Codex local carrier enabled flag is invalid.',
    { table: table.header },
  );
}

function safeRealDirectory(candidatePath: string, rootPath?: string) {
  const resolved = path.resolve(candidatePath);
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a real directory');
    const real = fs.realpathSync(resolved);
    if (rootPath) {
      const root = path.resolve(rootPath);
      const rootReal = fs.realpathSync(root);
      if (real === rootReal || !real.startsWith(`${rootReal}${path.sep}`)) {
        throw new Error('directory escapes owner root');
      }
    }
    return resolved;
  } catch {
    return localReadbackFailure(
      'configured_codex_plugin_carrier_local_source_unsafe',
      'Configured Codex local carrier source directory is missing or unsafe.',
      { candidate_path: resolved, owner_root: rootPath ?? null },
    );
  }
}

function safeJsonRecord(filePath: string, rootPath: string) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(rootPath);
  try {
    const stat = fs.lstatSync(resolved);
    const real = fs.realpathSync(resolved);
    const rootReal = fs.realpathSync(root);
    if (!stat.isFile() || stat.isSymbolicLink() || !real.startsWith(`${rootReal}${path.sep}`)) {
      throw new Error('JSON path is not a real file inside its owner root');
    }
    const parsed = parseJsonText(fs.readFileSync(resolved, 'utf8'));
    if (!isRecord(parsed)) throw new Error('JSON root is not an object');
    return parsed;
  } catch {
    return localReadbackFailure(
      'configured_codex_plugin_carrier_local_manifest_invalid',
      'Configured Codex local carrier manifest is missing, unsafe, or invalid.',
      { manifest_path: resolved, owner_root: root },
    );
  }
}

function assertSafeRequiredSkills(sourcePath: string, requiredSkillIds: string[]) {
  const skillsRoot = safePluginSkillsRoot(sourcePath);
  if (!skillsRoot) {
    localReadbackFailure(
      'configured_codex_plugin_carrier_local_required_skill_invalid',
      'Configured Codex local carrier Skill root is missing or unsafe.',
      { plugin_source_path: sourcePath },
    );
  }
  const skillsRootReal = fs.realpathSync(skillsRoot);
  for (const skillId of requiredSkillIds) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skillId)) {
      localReadbackFailure(
        'configured_codex_plugin_carrier_local_required_skill_invalid',
        'Configured Codex local carrier has an invalid required Skill identity.',
        { required_skill_id: skillId },
      );
    }
    const skillPath = path.join(skillsRoot, skillId, 'SKILL.md');
    if (!isSafeRequiredSkillFile(skillsRoot, skillsRootReal, skillId)) {
      localReadbackFailure(
        'configured_codex_plugin_carrier_local_required_skill_invalid',
        'Configured Codex local carrier required Skill is missing or unsafe.',
        { required_skill_id: skillId, required_skill_path: skillPath },
      );
    }
  }
}

function assertSafePluginTree(sourcePath: string) {
  const sourceRootReal = fs.realpathSync(sourcePath);
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current)) {
      const candidate = path.join(current, entry);
      const stat = fs.lstatSync(candidate);
      const real = fs.realpathSync(candidate);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())
        || !real.startsWith(`${sourceRootReal}${path.sep}`)) {
        localReadbackFailure(
          'configured_codex_plugin_carrier_local_source_unsafe',
          'Configured Codex local plugin tree contains an unsafe filesystem entry.',
          { plugin_source_path: sourcePath, unsafe_path: candidate },
        );
      }
      if (stat.isDirectory()) visit(candidate);
    }
  };
  visit(sourcePath);
}

function readConfiguredLocalPluginEntry(input: {
  descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor; env: NodeJS.ProcessEnv;
}): CodexPluginListEntry {
  const pluginId = input.descriptor.carrier.pluginId;
  const separator = pluginId.lastIndexOf('@');
  const pluginName = pluginId.slice(0, separator);
  const marketplaceId = pluginId.slice(separator + 1);
  const codexHome = safeRealDirectory(configuredCodexHome(input.env));
  const configPath = path.join(codexHome, 'config.toml');
  let configText: string;
  try {
    const stat = fs.lstatSync(configPath);
    const real = fs.realpathSync(configPath);
    const codexHomeReal = fs.realpathSync(codexHome);
    if (!stat.isFile() || stat.isSymbolicLink() || !real.startsWith(`${codexHomeReal}${path.sep}`)) {
      throw new Error('config is not a real file inside Codex home');
    }
    configText = fs.readFileSync(configPath, 'utf8');
  } catch {
    localReadbackFailure(
      'configured_codex_plugin_carrier_local_config_missing',
      'Configured Codex local carrier config is missing or unsafe.',
      { config_path: configPath },
    );
  }
  const document = parseTomlDocument(configText);
  const sameNamePluginTables = document.tables.filter((table) => {
    if (!table.header.startsWith('plugins.')) return false;
    return pluginBareName(table.header.slice('plugins.'.length)) === pluginName;
  });
  const pluginTables = sameNamePluginTables.filter((table) => table.header === `plugins.${pluginId}`);
  const marketplaceTables = document.tables.filter(
    (table) => table.header === `marketplaces.${marketplaceId}`,
  );
  if (sameNamePluginTables.length !== 1
    || pluginTables.length !== 1
    || marketplaceTables.length !== 1) {
    localReadbackFailure(
      'configured_codex_plugin_carrier_local_config_ambiguous',
      'Configured Codex local carrier does not have one exact plugin and marketplace table.',
      {
        plugin_id: pluginId,
        same_name_plugin_table_count: sameNamePluginTables.length,
        exact_plugin_table_count: pluginTables.length,
        marketplace_table_count: marketplaceTables.length,
      },
    );
  }
  const marketplaceTable = marketplaceTables[0];
  if (tomlStringValue(marketplaceTable, 'source_type') !== 'local') {
    localReadbackFailure(
      'configured_codex_plugin_carrier_local_marketplace_required',
      'Configured Codex filesystem readback only accepts a local marketplace.',
      { marketplace_id: marketplaceId },
    );
  }
  const configuredSource = tomlStringValue(marketplaceTable, 'source');
  const declaredSource = input.descriptor.carrier.marketplaceSource;
  if (!declaredSource
    || !path.isAbsolute(configuredSource)
    || path.resolve(configuredSource) !== path.resolve(declaredSource)) {
    localReadbackFailure(
      'configured_codex_plugin_carrier_local_marketplace_identity_mismatch',
      'Configured Codex local marketplace does not match the owner descriptor.',
      {
        marketplace_id: marketplaceId,
        configured_source: configuredSource,
        declared_source: declaredSource,
      },
    );
  }
  const marketplaceRoot = safeRealDirectory(configuredSource);
  const marketplaceManifest = safeJsonRecord(
    path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), marketplaceRoot);
  if (stringValue(marketplaceManifest.name) !== marketplaceId
    || !Array.isArray(marketplaceManifest.plugins)) {
    localReadbackFailure(
      'configured_codex_plugin_carrier_local_marketplace_identity_mismatch',
      'Configured Codex local marketplace manifest identity is invalid.',
      { marketplace_id: marketplaceId },
    );
  }
  const matchingPlugins = marketplaceManifest.plugins.flatMap((value) => {
    const entry = isRecord(value) ? value : null;
    return entry && stringValue(entry.name) === pluginName ? [entry] : [];
  });
  if (matchingPlugins.length !== 1) {
    localReadbackFailure(
      'configured_codex_plugin_carrier_local_marketplace_identity_mismatch',
      'Configured Codex local marketplace must declare one exact plugin source.',
      { plugin_id: pluginId, matching_plugin_count: matchingPlugins.length },
    );
  }
  const source = isRecord(matchingPlugins[0].source) ? matchingPlugins[0].source : null;
  const relativeSourcePath = stringValue(source?.path);
  if (stringValue(source?.source) !== 'local'
    || !relativeSourcePath
    || path.isAbsolute(relativeSourcePath)) {
    localReadbackFailure(
      'configured_codex_plugin_carrier_local_source_unsafe',
      'Configured Codex local marketplace plugin source is not a safe relative local path.',
      { plugin_id: pluginId, source_path: relativeSourcePath },
    );
  }
  const pluginSourcePath = safeRealDirectory(path.resolve(marketplaceRoot, relativeSourcePath), marketplaceRoot);
  const resolvedPlugin = resolveAgentPluginManifest([pluginSourcePath], { expectedName: pluginName });
  if (!resolvedPlugin) {
    localReadbackFailure(
      'configured_codex_plugin_carrier_local_manifest_invalid',
      'Configured Codex local carrier manifest is missing.',
      { plugin_source_path: pluginSourcePath },
    );
  }
  const pluginManifest = resolvedPlugin.manifest;
  const version = stringValue(pluginManifest.version);
  if (stringValue(pluginManifest.name) !== pluginName || !version) {
    localReadbackFailure(
      'configured_codex_plugin_carrier_local_plugin_identity_mismatch',
      'Configured Codex local plugin manifest identity is invalid.',
      { plugin_id: pluginId },
    );
  }
  assertSafePluginTree(pluginSourcePath);
  assertSafeRequiredSkills(pluginSourcePath, input.descriptor.executor.requiredSkillIds);
  return { pluginId, version, installed: true, enabled: tomlEnabledValue(pluginTables[0]),
    sourcePath: pluginSourcePath, marketplaceSource: marketplaceRoot };
}

function replacePluginEnabledTable(input: {
  configPath: string;
  pluginId: string;
  enabled: boolean;
  beforeConfigReplace?: () => void;
}) {
  const beforeExists = fs.existsSync(input.configPath);
  const before = beforeExists
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
    input.beforeConfigReplace?.();
    const currentExists = fs.existsSync(input.configPath);
    const current = currentExists
      ? fs.readFileSync(input.configPath, 'utf8')
      : '';
    if (currentExists !== beforeExists || current !== before) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Codex config changed during configured plugin toggle.',
        {
          plugin_id: input.pluginId,
          config_path: input.configPath,
          failure_code: 'configured_codex_plugin_carrier_config_apply_conflict',
        },
      );
    }
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
  beforeConfigReplace?: () => void;
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
    beforeConfigReplace: input.beforeConfigReplace,
  });
}

function ensureMarketplaceArgs(source: string) {
  return ['plugin', 'marketplace', 'add', source, '--json'];
}

function marketplaceName(pluginId: string) {
  return pluginId.slice(pluginId.lastIndexOf('@') + 1);
}

function projectedManifestPath(sourceRef: string) {
  return path.isAbsolute(sourceRef)
    ? sourceRef
    : path.join(PACKAGE_PROJECTION_ROOT, path.basename(sourceRef));
}

function packagePayloadProjection(packageId: string, packageDirectory?: string) {
  const projection = listCurrentPackageProjections(packageDirectory)
    .find((candidate) => candidate.payload.package_id === packageId);
  if (!projection) return null;
  const manifestPath = projectedManifestPath(projection.source_ref);
  const codexSurface = isRecord(projection.payload.codex_surface)
    ? projection.payload.codex_surface
    : null;
  const payloadRef = stringValue(codexSurface?.plugin_payload_manifest_url);
  const pluginId = stringValue(codexSurface?.plugin_id);
  const sourceCommit = stringValue(codexSurface?.carrier_source_commit)
    ?? stringValue(projection.payload.source_commit);
  const contentLock = isRecord(projection.payload.content_lock)
    ? projection.payload.content_lock
    : null;
  const contentLockPaths = Array.isArray(contentLock?.paths)
    ? contentLock.paths.filter((candidate): candidate is string => typeof candidate === 'string')
    : null;
  if (!payloadRef || !pluginId || !sourceCommit || !/^[0-9a-f]{40}$/.test(sourceCommit)) return null;
  const payloadPath = path.resolve(path.dirname(manifestPath), payloadRef);
  if (payloadPath !== path.dirname(manifestPath)
    && !payloadPath.startsWith(`${path.dirname(manifestPath)}${path.sep}`)) return null;
  return {
    payloadPath,
    pluginId,
    packageVersion: stringValue(projection.payload.version),
    sourceCommit,
    contentLockPaths,
  };
}

function payloadRelativePath(value: unknown, label: string) {
  const candidate = stringValue(value);
  if (!candidate || path.isAbsolute(candidate) || candidate.includes('\0')) {
    localReadbackFailure(
      'configured_codex_plugin_carrier_payload_invalid',
      `Configured Package payload ${label} is invalid.`,
    );
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === '..' || normalized.startsWith('../') || normalized !== candidate) {
    localReadbackFailure(
      'configured_codex_plugin_carrier_payload_invalid',
      `Configured Package payload ${label} escapes its plugin root.`,
    );
  }
  return normalized;
}

function payloadSha256(value: unknown, label: string) {
  const digest = stringValue(value);
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    localReadbackFailure(
      'configured_codex_plugin_carrier_payload_invalid',
      `Configured Package payload ${label} is not an exact SHA-256 digest.`,
    );
  }
  return digest;
}

function resolvePayloadFileSource(value: unknown, sourceCommit: string) {
  const source = stringValue(value);
  if (!source) {
    localReadbackFailure(
      'configured_codex_plugin_carrier_payload_invalid',
      'Configured Package payload file has no source URL.',
    );
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return localReadbackFailure(
      'configured_codex_plugin_carrier_payload_invalid',
      'Configured Package payload file source URL is invalid.',
    );
  }
  if (url.protocol === 'file:') return url;
  if (url.protocol !== 'https:'
    || url.hostname !== 'raw.githubusercontent.com'
    || !url.pathname.split('/').includes(sourceCommit)) {
    return localReadbackFailure(
      'configured_codex_plugin_carrier_payload_invalid',
      'Configured Package payload file source is not pinned to its owner commit.',
    );
  }
  return url;
}

function githubArchiveFileSource(source: URL, sourceCommit: string) {
  if (source.protocol !== 'https:' || source.hostname !== 'raw.githubusercontent.com') return null;
  const segments = source.pathname.split('/').filter(Boolean);
  const [owner, repository, commit, ...relativePath] = segments;
  if (!owner || !repository || commit !== sourceCommit || relativePath.length === 0) {
    return localReadbackFailure(
      'configured_codex_plugin_carrier_payload_invalid',
      'Configured Package payload file source is not pinned to one GitHub commit.',
    );
  }
  return {
    key: `${owner}/${repository}@${commit}`,
    archiveUrl: `https://codeload.github.com/${owner}/${repository}/tar.gz/${commit}`,
    relativePath: relativePath.join('/'),
  };
}

function materializeGithubArchive(input: {
  packageId: string;
  payloadFiles: readonly Record<string, unknown>[];
  sourceCommit: string;
  env: NodeJS.ProcessEnv;
}) {
  const sources = input.payloadFiles.map((candidate) => {
    const source = resolvePayloadFileSource(candidate.source_url, input.sourceCommit);
    return source ? { source, archive: githubArchiveFileSource(source, input.sourceCommit) } : null;
  });
  const githubSources = sources.filter(
    (value): value is { source: URL; archive: NonNullable<ReturnType<typeof githubArchiveFileSource>> } =>
      value !== null && value.archive !== null,
  );
  if (githubSources.length === 0) return null;
  const archiveKeys = new Set(githubSources.map((value) => value.archive.key));
  if (archiveKeys.size !== 1) {
    return localReadbackFailure(
      'configured_codex_plugin_carrier_payload_invalid',
      'Configured Package payload files reference more than one GitHub archive.',
      { package_id: input.packageId },
    );
  }
  const archive = githubSources[0].archive;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-archive-'));
  const archivePath = path.join(temporaryRoot, 'source.tar.gz');
  const curl = fs.existsSync('/usr/bin/curl') ? '/usr/bin/curl' : 'curl';
  const download = spawnSync(curl, [
    '--fail', '--silent', '--show-error', '--location',
    '--proto', '=https', '--tlsv1.2',
    '--connect-timeout', '10', '--max-time', '300',
    archive.archiveUrl,
    '--output', archivePath,
  ], { encoding: 'utf8', env: input.env, maxBuffer: 8 * 1024 * 1024 });
  if (download.status !== 0 || download.error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    return localReadbackFailure(
      'configured_codex_plugin_carrier_payload_download_failed',
      'Configured Package payload archive download did not complete.',
      {
        package_id: input.packageId,
        archive_url: archive.archiveUrl,
        exit_status: download.status,
        error: download.error?.message ?? download.stderr.trim() ?? null,
      },
    );
  }
  const extractRoot = path.join(temporaryRoot, 'source');
  fs.mkdirSync(extractRoot, { recursive: true });
  const extract = spawnSync('/usr/bin/tar', ['-xzf', archivePath, '-C', extractRoot], {
    encoding: 'utf8',
    env: input.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (extract.status !== 0 || extract.error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    return localReadbackFailure(
      'configured_codex_plugin_carrier_payload_invalid',
      'Configured Package payload archive could not be extracted.',
      { package_id: input.packageId, error: extract.error?.message ?? extract.stderr.trim() ?? null },
    );
  }
  const roots = fs.readdirSync(extractRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (roots.length !== 1) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    return localReadbackFailure(
      'configured_codex_plugin_carrier_payload_invalid',
      'Configured Package payload archive has an invalid root.',
      { package_id: input.packageId },
    );
  }
  const sourceRoot = path.join(extractRoot, roots[0].name);
  return {
    sourceRoot,
    cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }),
    pathFor: (relativePath: string) => {
      const candidate = path.resolve(sourceRoot, ...relativePath.split('/'));
      if (candidate !== sourceRoot && !candidate.startsWith(`${sourceRoot}${path.sep}`)) {
        return localReadbackFailure(
          'configured_codex_plugin_carrier_payload_invalid',
          'Configured Package payload path escapes its source archive.',
          { package_id: input.packageId, payload_path: relativePath },
        );
      }
      const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        return localReadbackFailure(
          'configured_codex_plugin_carrier_payload_invalid',
          'Configured Package payload archive is missing a declared physical file.',
          { package_id: input.packageId, payload_path: relativePath },
        );
      }
      return fs.readFileSync(candidate);
    },
  };
}

function writePayloadMarketplaceManifest(input: {
  marketplaceRoot: string;
  marketplaceId: string;
  pluginId: string;
}) {
  const manifestPath = path.join(input.marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    name: input.marketplaceId,
    plugins: [{
      name: input.pluginId,
      source: { source: 'local', path: `./plugins/${input.pluginId}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    }],
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function installPayloadMarketplace(input: {
  packageId: string;
  pluginId: string;
  env: NodeJS.ProcessEnv;
  packageDirectory?: string;
}) {
  const projection = packagePayloadProjection(input.packageId, input.packageDirectory);
  if (!projection || projection.pluginId !== pluginBareName(input.pluginId)) return null;
  let payload: Record<string, unknown>;
  try {
    const stat = fs.lstatSync(projection.payloadPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('payload manifest is not a physical file');
    payload = parseJsonText(fs.readFileSync(projection.payloadPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    return localReadbackFailure(
      'configured_codex_plugin_carrier_payload_invalid',
      'Configured Package payload manifest is missing or invalid.',
      { package_id: input.packageId, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!isRecord(payload)
    || payload.package_id !== input.packageId
    || payload.plugin_id !== projection.pluginId
    || payload.package_version !== projection.packageVersion
    || payload.source_commit !== projection.sourceCommit
    || !Array.isArray(payload.files)
    || payload.files.length === 0) {
    return localReadbackFailure(
      'configured_codex_plugin_carrier_payload_invalid',
      'Configured Package payload identity does not match its owner projection.',
      { package_id: input.packageId },
    );
  }

  const home = input.env.HOME?.trim() || os.homedir();
  const stateDir = input.env.OPL_STATE_DIR?.trim()
    ? path.resolve(input.env.OPL_STATE_DIR)
    : path.join(home, 'Library', 'Application Support', 'OPL', 'state');
  const marketplaceId = marketplaceName(input.pluginId);
  const marketplaceRoot = path.join(stateDir, 'codex-plugin-marketplaces', marketplaceId);
  const stagingRoot = `${marketplaceRoot}.${process.pid}.${crypto.randomUUID()}.staging`;
  const pluginRoot = path.join(stagingRoot, 'plugins', projection.pluginId);
  const downloaded = new Map<string, Buffer>();
  const archive = materializeGithubArchive({
    packageId: input.packageId,
    payloadFiles: payload.files.filter(isRecord),
    sourceCommit: projection.sourceCommit,
    env: input.env,
  });
  try {
    for (const [index, candidate] of payload.files.entries()) {
      if (!isRecord(candidate)) {
        localReadbackFailure(
          'configured_codex_plugin_carrier_payload_invalid',
          `Configured Package payload files[${index}] is invalid.`,
        );
      }
      const relativePath = payloadRelativePath(candidate.path, `files[${index}].path`);
      const expectedDigest = payloadSha256(candidate.sha256, `files[${index}].sha256`);
      const source = resolvePayloadFileSource(candidate.source_url, projection.sourceCommit);
      const destination = path.join(pluginRoot, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      let bytes: Buffer;
      if (source.protocol === 'file:') {
        bytes = fs.readFileSync(fileURLToPath(source));
      } else if (archive) {
        bytes = archive.pathFor(payloadRelativePath(candidate.path, `files[${index}].path`));
      } else {
        const curl = fs.existsSync('/usr/bin/curl') ? '/usr/bin/curl' : 'curl';
        const result = spawnSync(curl, [
          '--fail', '--silent', '--show-error', '--location',
          '--proto', '=https', '--tlsv1.2',
          '--connect-timeout', '10', '--max-time', '30',
          source.toString(),
        ], { encoding: null, env: input.env, maxBuffer: 128 * 1024 * 1024 });
        if (result.status !== 0 || result.error) {
          localReadbackFailure(
            'configured_codex_plugin_carrier_payload_download_failed',
            'Configured Package payload download did not complete.',
            {
              package_id: input.packageId,
              payload_path: relativePath,
              exit_status: result.status,
              error: result.error?.message ?? null,
            },
          );
        }
        bytes = result.stdout ?? Buffer.alloc(0);
      }
      const actualDigest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
      if (actualDigest !== expectedDigest) {
        localReadbackFailure(
          'configured_codex_plugin_carrier_payload_digest_mismatch',
          'Configured Package payload file digest does not match its owner manifest.',
          { package_id: input.packageId, payload_path: relativePath },
        );
      }
      fs.writeFileSync(destination, bytes, {
        mode: candidate.mode === '100755' ? 0o755 : 0o644,
      });
      downloaded.set(relativePath, bytes);
    }

    const lock = isRecord(payload.content_lock) ? payload.content_lock : null;
    const expectedLock = payloadSha256(lock?.digest, 'content_lock.digest');
    const contentHash = crypto.createHash('sha256');
    const contentLockPaths = projection.contentLockPaths ?? [...downloaded.keys()];
    if (contentLockPaths.length === 0
      || contentLockPaths.some((relativePath) => !downloaded.has(relativePath))) {
      localReadbackFailure(
        'configured_codex_plugin_carrier_payload_invalid',
        'Configured Package content lock paths do not match its payload files.',
        { package_id: input.packageId },
      );
    }
    for (const relativePath of contentLockPaths) {
      const bytes = downloaded.get(relativePath)!;
      const pathBytes = Buffer.from(relativePath, 'utf8');
      const pathLength = Buffer.allocUnsafe(8);
      const fileLength = Buffer.allocUnsafe(8);
      pathLength.writeBigUInt64BE(BigInt(pathBytes.length));
      fileLength.writeBigUInt64BE(BigInt(bytes.length));
      contentHash.update(pathLength);
      contentHash.update(pathBytes);
      contentHash.update(fileLength);
      contentHash.update(bytes);
    }
    if (`sha256:${contentHash.digest('hex')}` !== expectedLock) {
      localReadbackFailure(
        'configured_codex_plugin_carrier_payload_digest_mismatch',
        'Configured Package payload content lock does not match its owner manifest.',
        { package_id: input.packageId },
      );
    }
    if (!resolveAgentPluginManifest([pluginRoot], { expectedName: projection.pluginId })) {
      localReadbackFailure(
        'configured_codex_plugin_carrier_payload_invalid',
        'Configured Package payload does not contain its declared plugin manifest.',
        { package_id: input.packageId },
      );
    }
    writePayloadMarketplaceManifest({
      marketplaceRoot: stagingRoot,
      marketplaceId,
      pluginId: projection.pluginId,
    });

    const backupRoot = `${marketplaceRoot}.${process.pid}.previous`;
    fs.mkdirSync(path.dirname(marketplaceRoot), { recursive: true });
    fs.rmSync(backupRoot, { recursive: true, force: true });
    if (fs.existsSync(marketplaceRoot)) fs.renameSync(marketplaceRoot, backupRoot);
    try {
      fs.renameSync(stagingRoot, marketplaceRoot);
      fs.rmSync(backupRoot, { recursive: true, force: true });
    } catch (error) {
      if (!fs.existsSync(marketplaceRoot) && fs.existsSync(backupRoot)) {
        fs.renameSync(backupRoot, marketplaceRoot);
      }
      throw error;
    }
    return marketplaceRoot;
  } finally {
    archive?.cleanup();
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function ensureMarketplaceAvailable(input: {
  packageId: string;
  action: ConfiguredCodexPluginCarrierAction;
  pluginId: string;
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
  const marketplaces = marketplaceList.status === 0 && !marketplaceList.error
    ? parseMarketplaceList(marketplaceList.stdout, input.packageId)
    : [];
  const configuredMarketplace = marketplaces
    .find((entry) => sameMarketplaceSource(entry.marketplaceSource, input.marketplaceSource)) ?? null;
  if (configuredMarketplace) {
    if ((input.action !== 'update' && input.action !== 'repair')
      || configuredMarketplace.sourceType !== 'git') return;
    const upgradeArgs = [
      'plugin', 'marketplace', 'upgrade',
      configuredMarketplace.name ?? marketplaceName(input.pluginId),
      '--json',
    ];
    const upgradeResult = input.runner({
      binary: input.binary,
      args: upgradeArgs,
      env: input.env,
    });
    if (upgradeResult.status !== 0 || upgradeResult.error) {
      commandFailure({
        packageId: input.packageId,
        action: input.action,
        args: upgradeArgs,
        result: upgradeResult,
      });
    }
    return;
  }

  const expectedMarketplaceName = marketplaceName(input.pluginId);
  const replacedMarketplace = path.isAbsolute(input.marketplaceSource)
    ? marketplaces.find((entry) => (
      entry.name === expectedMarketplaceName
      && entry.sourceType === 'git'
      && entry.marketplaceSource
      && !sameMarketplaceSource(entry.marketplaceSource, input.marketplaceSource)
    )) ?? null
    : null;
  if (replacedMarketplace) {
    const removeArgs = ['plugin', 'marketplace', 'remove', expectedMarketplaceName, '--json'];
    const removeResult = input.runner({
      binary: input.binary,
      args: removeArgs,
      env: input.env,
    });
    if (removeResult.status !== 0 || removeResult.error) {
      commandFailure({
        packageId: input.packageId,
        action: input.action,
        args: removeArgs,
        result: removeResult,
      });
    }
  }

  const marketplaceArgs = ensureMarketplaceArgs(input.marketplaceSource);
  const marketplaceResult = input.runner({
    binary: input.binary,
    args: marketplaceArgs,
    env: input.env,
  });
  if (marketplaceResult.status !== 0 || marketplaceResult.error) {
    if (replacedMarketplace?.marketplaceSource) {
      input.runner({
        binary: input.binary,
        args: ensureMarketplaceArgs(replacedMarketplace.marketplaceSource),
        env: input.env,
      });
    }
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
    if (input.action === 'list' && list.error) {
      try {
        return {
          ...configuredPluginReadback({
            descriptor: input.descriptor,
            action: input.action,
            dryRun: false,
            dispatchAction: false,
            actionArgs: listArgs,
            entries: [readConfiguredLocalPluginEntry({
              descriptor: input.descriptor,
              env: input.env,
            })],
          }),
          native_action_dispatched: false,
        };
      } catch (error) {
        return invalidListReadback({
          descriptor: input.descriptor,
          action: input.action,
          listArgs,
          error,
        });
      }
    }
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
  const pluginName = pluginBareName(pluginId);
  const canonicalMarketplaceId = resolveCanonicalOplFamilyMarketplaceId(
    input.descriptor.packageId,
    pluginName,
  );
  const acceptedPluginIds = new Set([
    pluginId,
    ...(canonicalMarketplaceId ? [`${pluginName}@${canonicalMarketplaceId}`] : []),
  ]);
  const installedSameName = input.entries.filter(
    (candidate) => candidate.installed && pluginBareName(candidate.pluginId) === pluginName,
  );
  const acceptedEntries = installedSameName.filter((candidate) => acceptedPluginIds.has(candidate.pluginId));
  const entry = acceptedEntries.find((candidate) => candidate.enabled)
    ?? acceptedEntries.find((candidate) => candidate.pluginId === pluginId)
    ?? acceptedEntries[0]
    ?? null;
  const unexpectedSameName = installedSameName.filter(
    (candidate) => !acceptedPluginIds.has(candidate.pluginId),
  );
  const ambiguous = installedSameName.filter((candidate) => candidate.enabled).length > 1
    && Boolean(entry?.installed);
  const unexpectedOnly = !entry?.installed && unexpectedSameName.length > 0;
  const missingSkills = entry
    ? missingRequiredSkills(entry.sourcePath, input.descriptor.executor.requiredSkillIds)
    : input.descriptor.executor.requiredSkillIds;
  const callable = Boolean(entry?.installed && entry.enabled && missingSkills.length === 0 && !ambiguous && !unexpectedOnly);
  return { installedSameName, entry, unexpectedSameName, ambiguous, unexpectedOnly, missingSkills, callable };
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

function configuredCarrierActionNeedsMarketplace(action: ConfiguredCodexPluginCarrierAction) {
  return action === 'install' || action === 'update' || action === 'repair';
}

export function runConfiguredCodexPluginCarrier(input: {
  descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor;
  action: ConfiguredCodexPluginCarrierAction;
  dryRun?: boolean;
  binary?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CodexPluginCommandRunner;
  beforeConfigReplace?: () => void;
  packageDirectory?: string;
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
  const declaredMarketplaceSource = input.descriptor.carrier.marketplaceSource;
  const marketplaceSource = dispatchAction && input.action === 'install'
    ? installPayloadMarketplace({
        packageId: input.descriptor.packageId,
        pluginId: input.descriptor.carrier.pluginId,
        env,
        packageDirectory: input.packageDirectory,
      }) ?? declaredMarketplaceSource
    : declaredMarketplaceSource;
  if (dispatchAction && configuredCarrierActionNeedsMarketplace(input.action) && marketplaceSource) {
    ensureMarketplaceAvailable({
      packageId: input.descriptor.packageId,
      action: input.action,
      pluginId: input.descriptor.carrier.pluginId,
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
  if ((input.action === 'update' || input.action === 'repair') && marketplaceSource) {
    const selection = configuredPluginSelection({ entries, descriptor: input.descriptor });
    const targetEntry = selection.installedSameName.find((entry) => (
      entry.enabled
      && sameMarketplaceSource(entry.marketplaceSource, marketplaceSource)
      && missingRequiredSkills(
        entry.sourcePath,
        input.descriptor.executor.requiredSkillIds,
      ).length === 0
    )) ?? null;
    const staleSameNameSources = targetEntry
      ? selection.installedSameName.filter(
        (entry) => !sameMarketplaceSource(entry.marketplaceSource, marketplaceSource),
      )
      : [];
    if (targetEntry && staleSameNameSources.length > 0) {
      for (const pluginId of new Set(staleSameNameSources.map((entry) => entry.pluginId))) {
        const removeArgs = nativeArgs('remove', pluginId);
        dispatchConfiguredPluginAction({
          dispatchAction: true,
          packageId: input.descriptor.packageId,
          action: input.action,
          actionArgs: removeArgs,
          binary,
          env,
          runner,
        });
      }
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
  }
  if (isConfigToggle && input.dryRun !== true) {
    setConfiguredPluginEnabled({
      descriptor: input.descriptor,
      entries,
      enabled: input.action === 'enable',
      env,
      beforeConfigReplace: input.beforeConfigReplace,
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
