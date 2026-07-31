import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { formatJsonPayload, parseJsonText } from '../../../kernel/json-file.ts';
import {
  runConfiguredCodexPluginCarrier,
  type CodexPluginCommandRunner,
  type ConfiguredCodexPluginCarrierAction,
  type ConfiguredCodexPluginCarrierReadback,
} from './configured-codex-plugin-carrier.ts';
import type { AgentPackageConfiguredCodexPluginCarrierDescriptor } from './types.ts';

const FLOW_PACKAGE_ID = 'opl-flow';
const LEGACY_SOURCE = 'gaofeng21cn/opl-skills';
const LEGACY_SOURCE_TYPE = 'github';
const LEGACY_SOURCE_URL = 'https://github.com/gaofeng21cn/opl-skills.git';
const MIGRATED_SKILL_IDS = [
  'develop-and-deliver',
  'task-mode-gate',
  'recover-codex-tasks',
] as const;

type SkillLockDocument = Record<string, unknown> & {
  skills: Record<string, unknown>;
};

export type LegacyOplSkillsMigrationReadback = {
  surface_kind: 'opl_flow_legacy_opl_skills_migration.v1';
  status: 'not_required' | 'validated_no_write' | 'migrated';
  package_id: string;
  source: typeof LEGACY_SOURCE;
  skill_ids: string[];
  backup_root: string | null;
  writes_performed: boolean;
};

export type PreparedLegacyOplSkillsMigration = {
  readback: LegacyOplSkillsMigrationReadback;
  commit: () => LegacyOplSkillsMigrationReadback;
  rollback: () => void;
};

function configuredAgentsRoot(env: NodeJS.ProcessEnv) {
  const home = env.HOME?.trim() || os.homedir();
  return path.join(path.resolve(home), '.agents');
}

function migrationFailure(message: string, failureCode: string, details: Record<string, unknown> = {}): never {
  throw new FrameworkContractError('contract_shape_invalid', message, {
    package_id: FLOW_PACKAGE_ID,
    skill_ids: [...MIGRATED_SKILL_IDS],
    ...details,
    failure_code: failureCode,
  });
}

function readSkillLock(lockPath: string, targetPathsPresent: boolean) {
  if (!fs.existsSync(lockPath)) {
    if (targetPathsPresent) {
      migrationFailure(
        'Legacy OPL Skills directories exist without a source lock.',
        'opl_flow_legacy_skill_lock_missing',
        { lock_path: lockPath },
      );
    }
    return null;
  }
  const raw = fs.readFileSync(lockPath);
  let parsed: unknown;
  try {
    parsed = parseJsonText(raw.toString('utf8'));
  } catch {
    migrationFailure(
      'Legacy OPL Skills source lock is not valid JSON.',
      'opl_flow_legacy_skill_lock_invalid_json',
      { lock_path: lockPath },
    );
  }
  if (!isRecord(parsed) || parsed.version !== 3 || !isRecord(parsed.skills)) {
    migrationFailure(
      'Legacy OPL Skills source lock has an unsupported shape.',
      'opl_flow_legacy_skill_lock_invalid_shape',
      { lock_path: lockPath },
    );
  }
  return { raw, document: parsed as SkillLockDocument };
}

function exactLegacyEntry(skillId: string, value: unknown) {
  return isRecord(value)
    && value.source === LEGACY_SOURCE
    && value.sourceType === LEGACY_SOURCE_TYPE
    && value.sourceUrl === LEGACY_SOURCE_URL
    && value.skillPath === `skills/${skillId}/SKILL.md`;
}

function writeFileCas(filePath: string, expected: Buffer, next: Buffer, failureCode: string) {
  const current = fs.readFileSync(filePath);
  if (!current.equals(expected)) {
    migrationFailure(
      'Legacy OPL Skills source lock changed during migration.',
      failureCode,
      { lock_path: filePath },
    );
  }
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, next, { mode: fs.statSync(filePath).mode & 0o777 });
    const beforeReplace = fs.readFileSync(filePath);
    if (!beforeReplace.equals(expected)) {
      migrationFailure(
        'Legacy OPL Skills source lock changed during migration.',
        failureCode,
        { lock_path: filePath },
      );
    }
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function notRequiredReadback(): LegacyOplSkillsMigrationReadback {
  return {
    surface_kind: 'opl_flow_legacy_opl_skills_migration.v1',
    status: 'not_required',
    package_id: FLOW_PACKAGE_ID,
    source: LEGACY_SOURCE,
    skill_ids: [],
    backup_root: null,
    writes_performed: false,
  };
}

export function prepareLegacyOplSkillsMigration(input: {
  packageId: string;
  requiredSkillIds: string[];
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
}): PreparedLegacyOplSkillsMigration {
  if (input.packageId !== FLOW_PACKAGE_ID
    || !MIGRATED_SKILL_IDS.every((skillId) => input.requiredSkillIds.includes(skillId))) {
    const readback = notRequiredReadback();
    return { readback, commit: () => readback, rollback: () => {} };
  }
  const agentsRoot = configuredAgentsRoot(input.env);
  const skillsRoot = path.join(agentsRoot, 'skills');
  const lockPath = path.join(agentsRoot, '.skill-lock.json');
  const targetPaths = MIGRATED_SKILL_IDS.map((skillId) => ({
    skillId,
    skillPath: path.join(skillsRoot, skillId),
  }));
  const targetPathsPresent = targetPaths.some((entry) => fs.existsSync(entry.skillPath));
  const lock = readSkillLock(lockPath, targetPathsPresent);
  if (!lock) {
    const readback = notRequiredReadback();
    return { readback, commit: () => readback, rollback: () => {} };
  }

  const entries = targetPaths.map((target) => ({
    ...target,
    lockEntry: lock.document.skills[target.skillId],
    pathPresent: fs.existsSync(target.skillPath),
  }));
  const anyDeclared = entries.some((entry) => entry.lockEntry !== undefined);
  const anyPresent = entries.some((entry) => entry.pathPresent);
  if (!anyDeclared && !anyPresent) {
    const readback = notRequiredReadback();
    return { readback, commit: () => readback, rollback: () => {} };
  }
  for (const entry of entries) {
    if (entry.pathPresent !== (entry.lockEntry !== undefined)) {
      migrationFailure(
        'Legacy OPL Skills projection is incomplete and cannot be migrated safely.',
        'opl_flow_legacy_skill_projection_incomplete',
        { skill_id: entry.skillId, path_present: entry.pathPresent, lock_entry_present: entry.lockEntry !== undefined },
      );
    }
    if (!entry.pathPresent) continue;
    const stat = fs.lstatSync(entry.skillPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      migrationFailure(
        'Legacy OPL Skills projection must be a real directory.',
        'opl_flow_legacy_skill_projection_invalid_path',
        { skill_id: entry.skillId, skill_path: entry.skillPath },
      );
    }
    if (!exactLegacyEntry(entry.skillId, entry.lockEntry)) {
      migrationFailure(
        'Legacy core Skill has a different or ambiguous source owner.',
        'opl_flow_legacy_skill_source_conflict',
        { skill_id: entry.skillId, skill_path: entry.skillPath },
      );
    }
  }

  const selectedEntries = entries.filter((entry) => entry.pathPresent);

  const nextDocument = structuredClone(lock.document);
  for (const skillId of MIGRATED_SKILL_IDS) delete nextDocument.skills[skillId];
  const nextLock = Buffer.from(formatJsonPayload(nextDocument));
  if (input.dryRun) {
    const readback: LegacyOplSkillsMigrationReadback = {
      ...notRequiredReadback(),
      status: 'validated_no_write',
      skill_ids: selectedEntries.map((entry) => entry.skillId),
    };
    return { readback, commit: () => readback, rollback: () => {} };
  }

  const backupParent = path.join(agentsRoot, '.opl-flow-migration-backups');
  fs.mkdirSync(backupParent, { recursive: true, mode: 0o700 });
  const backupRoot = fs.mkdtempSync(path.join(backupParent, 'core-skills-'));
  const backupSkillsRoot = path.join(backupRoot, 'skills');
  fs.mkdirSync(backupSkillsRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(backupRoot, 'skill-lock.json'), lock.raw, { mode: 0o600 });
  let lockRewritten = false;
  let active = true;
  const moved: Array<{ source: string; backup: string }> = [];

  const restore = () => {
    if (!active) return;
    if (lockRewritten) {
      writeFileCas(
        lockPath,
        nextLock,
        lock.raw,
        'opl_flow_legacy_skill_rollback_lock_conflict',
      );
      lockRewritten = false;
    }
    for (const entry of moved.slice().reverse()) {
      if (fs.existsSync(entry.backup) && fs.existsSync(entry.source)) {
        migrationFailure(
          'Legacy OPL Skills rollback target was recreated concurrently.',
          'opl_flow_legacy_skill_rollback_path_conflict',
          { skill_path: entry.source },
        );
      }
      if (fs.existsSync(entry.backup)) fs.renameSync(entry.backup, entry.source);
    }
    fs.rmSync(backupRoot, { recursive: true, force: true });
    active = false;
  };

  try {
    for (const entry of selectedEntries) {
      const backupPath = path.join(backupSkillsRoot, entry.skillId);
      fs.renameSync(entry.skillPath, backupPath);
      moved.push({ source: entry.skillPath, backup: backupPath });
    }
    writeFileCas(
      lockPath,
      lock.raw,
      nextLock,
      'opl_flow_legacy_skill_apply_lock_conflict',
    );
    lockRewritten = true;
  } catch (error) {
    try {
      restore();
    } catch (rollbackError) {
      throw rollbackError;
    }
    throw error;
  }

  const readback: LegacyOplSkillsMigrationReadback = {
    ...notRequiredReadback(),
    status: 'migrated',
    skill_ids: selectedEntries.map((entry) => entry.skillId),
    backup_root: backupRoot,
    writes_performed: true,
  };
  return {
    readback,
    commit: () => {
      active = false;
      return readback;
    },
    rollback: restore,
  };
}

function requiresLegacyMigration(input: {
  descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor;
  action: ConfiguredCodexPluginCarrierAction;
}) {
  return input.descriptor.packageId === FLOW_PACKAGE_ID
    && (input.action === 'install' || input.action === 'update' || input.action === 'repair')
    && MIGRATED_SKILL_IDS.every((skillId) => input.descriptor.executor.requiredSkillIds.includes(skillId));
}

function assertMigrationCarrierReadback(readback: ConfiguredCodexPluginCarrierReadback) {
  if (
    readback.status !== 'installed'
    || readback.executor.status !== 'callable'
    || readback.carrier.precedence !== 'exact_single_source'
  ) {
    migrationFailure(
      'OPL Flow native carrier did not expose one callable source after legacy Skill migration.',
      'opl_flow_legacy_skill_native_readback_failed',
      {
        carrier_status: readback.status,
        executor_status: readback.executor.status,
        carrier_precedence: readback.carrier.precedence,
        carrier_reason: readback.reason,
      },
    );
  }
}

export function runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration(input: {
  descriptor: AgentPackageConfiguredCodexPluginCarrierDescriptor;
  action: ConfiguredCodexPluginCarrierAction;
  dryRun?: boolean;
  binary?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CodexPluginCommandRunner;
}): {
  carrier: ConfiguredCodexPluginCarrierReadback;
  legacySkillMigration: LegacyOplSkillsMigrationReadback;
} {
  const env = { ...process.env, ...input.env };
  if (!requiresLegacyMigration(input)) {
    return {
      carrier: runConfiguredCodexPluginCarrier(input),
      legacySkillMigration: notRequiredReadback(),
    };
  }

  const migration = prepareLegacyOplSkillsMigration({
    packageId: input.descriptor.packageId,
    requiredSkillIds: input.descriptor.executor.requiredSkillIds,
    dryRun: input.dryRun === true,
    env,
  });
  try {
    const carrier = runConfiguredCodexPluginCarrier({ ...input, env });
    if (input.dryRun !== true) assertMigrationCarrierReadback(carrier);
    return {
      carrier,
      legacySkillMigration: migration.commit(),
    };
  } catch (error) {
    migration.rollback();
    throw error;
  }
}
