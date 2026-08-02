import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import {
  readJsonFileResult,
  writeJsonPayloadFile,
} from '../../../kernel/json-file.ts';
import { stringValue } from '../../../kernel/json-record.ts';
import { ensureOplStateDir, resolveOplStatePaths } from '../../../kernel/runtime-state-paths.ts';
import { canonicalAgentPackageId } from '../agent-package-identity.ts';
import type {
  AgentPackageLock,
  AgentPackageLockIndex,
} from './types.ts';

type PackageLifecycleTransactionOptions = {
  timeoutMs?: number;
  retryMs?: number;
};

type PackageTransactionWriteOptions = {
  removeEmptyAuthorities?: boolean;
};

const PACKAGE_LIFECYCLE_LOCK_TIMEOUT_MS = 5_000;
const packageLifecycleTransactionContext = new AsyncLocalStorage<boolean>();

function packageLifecycleLockPath() {
  return path.join(ensureOplStateDir().state_dir, 'agent-package-lifecycle.sqlite');
}

function packageLifecycleLockTimeoutError(lockPath: string) {
  return new FrameworkContractError('runtime_state_lock_timeout', 'Timed out waiting for another agent package lifecycle transaction.', {
    lock_path: lockPath,
    owner_pid_alive: null,
    failure_code: 'agent_package_lifecycle_lock_timeout',
  });
}

function normalizedLockTiming(options: PackageLifecycleTransactionOptions) {
  return {
    timeoutMs: Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) >= 0
      ? Number(options.timeoutMs)
      : PACKAGE_LIFECYCLE_LOCK_TIMEOUT_MS,
  };
}

function acquirePackageLifecycleLock(options: PackageLifecycleTransactionOptions) {
  const lockPath = packageLifecycleLockPath();
  const timing = normalizedLockTiming(options);
  const db = new DatabaseSync(lockPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.floor(timing.timeoutMs)};`);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('CREATE TABLE IF NOT EXISTS lifecycle_mutex (singleton INTEGER PRIMARY KEY CHECK (singleton = 1));');
    db.exec('BEGIN IMMEDIATE;');
    return { db, path: lockPath };
  } catch (error) {
    db.close();
    const message = error instanceof Error ? error.message : String(error);
    if (/busy|locked/i.test(message)) throw packageLifecycleLockTimeoutError(lockPath);
    throw error;
  }
}

function releasePackageLifecycleLock(
  acquired: ReturnType<typeof acquirePackageLifecycleLock>,
  commit: boolean,
) {
  try {
    acquired.db.exec(commit ? 'COMMIT;' : 'ROLLBACK;');
  } finally {
    acquired.db.close();
  }
}

export async function withAgentPackageLifecycleTransaction<T>(
  dryRun: boolean,
  operation: () => Promise<T>,
  options: PackageLifecycleTransactionOptions = {},
): Promise<T> {
  if (dryRun || packageLifecycleTransactionContext.getStore()) {
    return await operation();
  }
  const acquired = acquirePackageLifecycleLock(options);
  try {
    const result = await packageLifecycleTransactionContext.run(true, operation);
    releasePackageLifecycleLock(acquired, true);
    return result;
  } catch (error) {
    releasePackageLifecycleLock(acquired, false);
    throw error;
  }
}

function emptyLockIndex(): AgentPackageLockIndex {
  return {
    surface_kind: 'opl_agent_package_lock_index',
    version: 'opl-agent-package-lock-index.v1',
    packages: [],
  };
}

type PackageAuthorityKind = 'lock_index';

function packageAuthorityCorrupt(
  authorityKind: PackageAuthorityKind,
  filePath: string,
  reason: 'invalid_json' | 'invalid_shape',
  details: Record<string, unknown> = {},
) {
  const label = 'Agent package lock index';
  return new FrameworkContractError(
    reason === 'invalid_json' ? 'contract_json_invalid' : 'contract_shape_invalid',
    `${label} exists but is corrupt; restore or repair it before Package lifecycle mutation.`,
    {
      failure_code: 'agent_package_lock_authority_corrupt',
      authority_kind: authorityKind,
      authority_status: 'corrupt',
      authority_file: filePath,
      recovery_required: true,
      write_allowed: false,
      reason,
      ...details,
    },
  );
}

function withoutLegacyCatalogSelectionPolicy(value: unknown) {
  if (!isRecord(value) || value.kind !== 'managed_version_catalog') return value;
  const normalized = { ...value };
  delete normalized.selection_policy;
  return normalized;
}

function withoutLegacyCatalogSelectionPolicies(value: Record<string, unknown>) {
  const normalized = { ...value };
  normalized.managed_update_source = withoutLegacyCatalogSelectionPolicy(value.managed_update_source);
  if (Array.isArray(value.capability_dependencies)) {
    normalized.capability_dependencies = value.capability_dependencies.map((dependency) => {
      if (!isRecord(dependency)) return dependency;
      return {
        ...dependency,
        dependency_source: withoutLegacyCatalogSelectionPolicy(dependency.dependency_source),
      };
    });
  }
  return normalized;
}

function normalizeLockEntry(
  value: unknown,
  filePath: string,
  field: string,
  index: number,
): AgentPackageLock {
  if (!isRecord(value)) {
    throw packageAuthorityCorrupt('lock_index', filePath, 'invalid_shape', {
      field,
      invalid_entry_index: index,
    });
  }
  const declaredPackageId = stringValue(value.package_id)?.toLowerCase() ?? null;
  const packageId = canonicalAgentPackageId(declaredPackageId);
  const lockRef = stringValue(value.lock_ref);
  const declaredAgentId = stringValue(value.agent_id)?.toLowerCase() ?? null;
  const agentId = declaredAgentId === null ? null : canonicalAgentPackageId(declaredAgentId);
  if (
    packageId !== declaredPackageId
    || !packageId
    || !lockRef
    || (declaredAgentId !== null && agentId !== declaredAgentId)
  ) {
    throw packageAuthorityCorrupt('lock_index', filePath, 'invalid_shape', {
      field,
      invalid_entry_index: index,
      declared_package_id: declaredPackageId,
      declared_agent_id: declaredAgentId,
    });
  }
  const normalizedValue = withoutLegacyCatalogSelectionPolicies(value);
  delete normalizedValue.action_receipt_id;
  return {
    ...normalizedValue,
    package_id: packageId,
    agent_id: agentId,
  } as AgentPackageLock;
}

function normalizeLockIndex(value: unknown, filePath: string): AgentPackageLockIndex {
  if (
    !isRecord(value)
    || value.surface_kind !== 'opl_agent_package_lock_index'
    || value.version !== 'opl-agent-package-lock-index.v1'
    || !Array.isArray(value.packages)
  ) {
    throw packageAuthorityCorrupt('lock_index', filePath, 'invalid_shape');
  }
  const packages = value.packages.map((entry, index) =>
    normalizeLockEntry(entry, filePath, 'packages', index)
  );
  const packageIds = packages.map((entry) => entry.package_id);
  if (new Set(packageIds).size !== packageIds.length) {
    throw packageAuthorityCorrupt('lock_index', filePath, 'invalid_shape', {
      field: 'packages',
      reason_code: 'duplicate_package_id',
    });
  }
  return {
    ...emptyLockIndex(),
    packages,
  };
}

export function readLockIndex(): AgentPackageLockIndex {
  const filePath = resolveOplStatePaths().agent_package_lock_file;
  const result = readJsonFileResult(filePath);
  if (result.status === 'missing') {
    return emptyLockIndex();
  }
  if (result.status === 'invalid_json') {
    throw packageAuthorityCorrupt('lock_index', filePath, 'invalid_json', {
      parse_error: result.error,
    });
  }
  return normalizeLockIndex(result.payload, filePath);
}

export function writePackageTransaction(
  index: AgentPackageLockIndex,
  options: PackageTransactionWriteOptions = {},
) {
  const paths = ensureOplStateDir();
  readLockIndex();
  const previousLock = fs.existsSync(paths.agent_package_lock_file)
    ? fs.readFileSync(paths.agent_package_lock_file)
    : null;
  const normalizedIndex = normalizeLockIndex(index, paths.agent_package_lock_file);
  try {
    if (
      options.removeEmptyAuthorities
      && normalizedIndex.packages.length === 0
    ) {
      fs.rmSync(paths.agent_package_lock_file, { force: true });
    } else {
      writeJsonPayloadFile(paths.agent_package_lock_file, normalizedIndex);
    }
  } catch (error) {
    if (previousLock) fs.writeFileSync(paths.agent_package_lock_file, previousLock);
    else fs.rmSync(paths.agent_package_lock_file, { force: true });
    throw error;
  }
}
