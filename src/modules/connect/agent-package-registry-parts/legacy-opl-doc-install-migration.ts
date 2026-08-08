import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseJsonText } from '../../../kernel/json-file.ts';


export type LegacyOplDocInstallMigration = {
  surface_kind: 'opl_legacy_opl_doc_install_migration.v1';
  status: 'absent' | 'validated_no_write' | 'completed' | 'manual_required';
  writes_performed: boolean;
  failure_code: string | null;
  plugin_root: string;
  command_path: string;
  marketplace_path: string;
  before: {
    plugin_root: boolean;
    command: boolean;
    marketplace_entry: boolean;
  };
  after: {
    plugin_root: boolean;
    command: boolean;
    marketplace_entry: boolean;
  };
};

type MigrationInput = {
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  beforeMarketplaceReplace?: () => void;
};

function pathEntryExists(filePath: string) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactMarketplaceEntry(value: unknown) {
  if (!isRecord(value) || value.name !== 'opl-doc' || !isRecord(value.source)) return false;
  return value.source.source === 'local' && value.source.path === './plugins/opl-doc';
}

function safeRegularFile(root: string, relativePath: string) {
  const candidate = path.join(root, relativePath);
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const real = fs.realpathSync.native(candidate);
  return real.startsWith(`${fs.realpathSync.native(root)}${path.sep}`) ? real : null;
}

function readMarketplace(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return { text: null, document: null, plugins: [], exactIndexes: [], sameNameIndexes: [] };
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('marketplace_not_safe_regular_file');
  const text = fs.readFileSync(filePath, 'utf8');
  const document = parseJsonText(text);
  if (!isRecord(document) || !Array.isArray(document.plugins)) {
    throw new Error('marketplace_shape_invalid');
  }
  const plugins = document.plugins;
  return {
    text,
    document,
    plugins,
    exactIndexes: plugins.flatMap((entry, index) => exactMarketplaceEntry(entry) ? [index] : []),
    sameNameIndexes: plugins.flatMap((entry, index) =>
      isRecord(entry) && entry.name === 'opl-doc' ? [index] : []),
  };
}

function atomicReplace(filePath: string, expectedText: string, value: unknown, beforeReplace?: () => void) {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    beforeReplace?.();
    if (fs.readFileSync(filePath, 'utf8') !== expectedText) throw new Error('marketplace_changed_before_replace');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function surface(input: {
  status: LegacyOplDocInstallMigration['status'];
  writesPerformed: boolean;
  failureCode: string | null;
  pluginRoot: string;
  commandPath: string;
  marketplacePath: string;
  before: LegacyOplDocInstallMigration['before'];
  after: LegacyOplDocInstallMigration['after'];
}): LegacyOplDocInstallMigration {
  return {
    surface_kind: 'opl_legacy_opl_doc_install_migration.v1',
    status: input.status,
    writes_performed: input.writesPerformed,
    failure_code: input.failureCode,
    plugin_root: input.pluginRoot,
    command_path: input.commandPath,
    marketplace_path: input.marketplacePath,
    before: input.before,
    after: input.after,
  };
}

export function migrateLegacyOplDocInstall(
  input: MigrationInput = {},
): LegacyOplDocInstallMigration {
  const env = input.env ?? process.env;
  const home = env.HOME?.trim() || os.homedir();
  const pluginRoot = path.join(home, 'plugins', 'opl-doc');
  const commandPath = path.join(home, '.local', 'bin', 'opl-doc-doctor');
  const marketplacePath = path.join(home, '.agents', 'plugins', 'marketplace.json');
  const initialMarketplace = (() => {
    try {
      return readMarketplace(marketplacePath);
    } catch {
      return null;
    }
  })();
  const before = {
    plugin_root: fs.existsSync(pluginRoot),
    command: pathEntryExists(commandPath),
    marketplace_entry: initialMarketplace?.exactIndexes.length === 1,
  };
  const marketplaceCandidate = (initialMarketplace?.sameNameIndexes.length ?? 0) > 0;
  const absent = !before.plugin_root && !before.command && !marketplaceCandidate;
  if (absent) {
    return surface({
      status: 'absent', writesPerformed: false, failureCode: null,
      pluginRoot, commandPath, marketplacePath, before, after: before,
    });
  }

  let marketplace;
  let doctorPath: string;
  try {
    const rootStat = fs.lstatSync(pluginRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('plugin_root_not_safe_directory');
    const manifestPath = safeRegularFile(pluginRoot, '.codex-plugin/plugin.json');
    doctorPath = safeRegularFile(pluginRoot, 'scripts/opl_doc_doctor.py') ?? '';
    const skillPath = safeRegularFile(pluginRoot, 'skills/opl-doc/SKILL.md');
    if (!manifestPath || !doctorPath || !skillPath) throw new Error('plugin_identity_files_invalid');
    const manifest = parseJsonText(fs.readFileSync(manifestPath, 'utf8'));
    if (!isRecord(manifest) || manifest.name !== 'opl-doc') throw new Error('plugin_manifest_identity_mismatch');

    if (before.command) {
      const commandStat = fs.lstatSync(commandPath);
      if (!commandStat.isSymbolicLink() || fs.realpathSync.native(commandPath) !== doctorPath) {
        throw new Error('command_identity_mismatch');
      }
    }

    marketplace = readMarketplace(marketplacePath);
    if (marketplace.sameNameIndexes.length !== marketplace.exactIndexes.length
      || marketplace.exactIndexes.length > 1) {
      throw new Error('marketplace_identity_ambiguous');
    }
  } catch (error) {
    return surface({
      status: 'manual_required', writesPerformed: false,
      failureCode: error instanceof Error ? error.message : 'legacy_opl_doc_preflight_failed',
      pluginRoot, commandPath, marketplacePath, before, after: before,
    });
  }

  if (input.dryRun) {
    return surface({
      status: 'validated_no_write', writesPerformed: false, failureCode: null,
      pluginRoot, commandPath, marketplacePath, before, after: before,
    });
  }

  let writesPerformed = false;
  try {
    if (marketplace.text !== null && marketplace.document && marketplace.exactIndexes.length === 1) {
      marketplace.document.plugins = marketplace.plugins.filter((_, index) =>
        index !== marketplace.exactIndexes[0]);
      atomicReplace(marketplacePath, marketplace.text, marketplace.document, input.beforeMarketplaceReplace);
      writesPerformed = true;
    }
    if (before.command) {
      fs.unlinkSync(commandPath);
      writesPerformed = true;
    }
    fs.rmSync(pluginRoot, { recursive: true });
    writesPerformed = true;
  } catch (error) {
    const currentMarketplace = (() => {
      try { return readMarketplace(marketplacePath); } catch { return null; }
    })();
    return surface({
      status: 'manual_required', writesPerformed,
      failureCode: error instanceof Error ? error.message : 'legacy_opl_doc_write_failed',
      pluginRoot, commandPath, marketplacePath, before,
      after: {
        plugin_root: fs.existsSync(pluginRoot),
        command: pathEntryExists(commandPath),
        marketplace_entry: currentMarketplace?.exactIndexes.length === 1,
      },
    });
  }

  const finalMarketplace = readMarketplace(marketplacePath);
  const after = {
    plugin_root: fs.existsSync(pluginRoot),
    command: pathEntryExists(commandPath),
    marketplace_entry: finalMarketplace.exactIndexes.length === 1,
  };
  return surface({
    status: after.plugin_root || after.command || after.marketplace_entry ? 'manual_required' : 'completed',
    writesPerformed,
    failureCode: after.plugin_root || after.command || after.marketplace_entry
      ? 'legacy_opl_doc_post_verify_incomplete'
      : null,
    pluginRoot, commandPath, marketplacePath, before, after,
  });
}
