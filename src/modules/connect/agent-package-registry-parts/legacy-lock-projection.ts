import { isRecord } from '../../../kernel/contract-validation.ts';
import { discoverInstalledCodexPluginDescriptors } from './installed-codex-plugin-directory.ts';
import { readLockIndex } from './store.ts';
import type { AgentPackageLock, AgentPackageLockIndex } from './types.ts';

function descriptorOwnedLock(
  lock: unknown,
  installedDescriptors: ReadonlyMap<string, unknown>,
): lock is AgentPackageLock {
  return isRecord(lock)
    && typeof lock.package_id === 'string'
    && installedDescriptors.has(lock.package_id);
}

/**
 * Keep legacy storage consumers on the lock authority while removing native
 * descriptor-owned packages from their view, including retained LKG entries.
 */
export function readLegacyAgentPackageLockIndex(): AgentPackageLockIndex {
  const installedDescriptors = discoverInstalledCodexPluginDescriptors();
  const index = readLockIndex();
  const lastKnownGoodTransactions = index.last_known_good_transactions?.map((transaction) => {
    if (!Array.isArray(transaction.package_locks)) return transaction;
    return {
      ...transaction,
      package_locks: transaction.package_locks.filter(
        (lock) => !descriptorOwnedLock(lock, installedDescriptors),
      ),
    };
  });
  return {
    ...index,
    packages: index.packages.filter(
      (lock) => !descriptorOwnedLock(lock, installedDescriptors),
    ),
    ...(lastKnownGoodTransactions === undefined
      ? {}
      : { last_known_good_transactions: lastKnownGoodTransactions }),
  };
}
