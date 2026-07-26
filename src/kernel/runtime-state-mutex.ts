import { DatabaseSync } from 'node:sqlite';

import { FrameworkContractError } from './contract-validation.ts';

export function withRuntimeStateMutex<T>(
  input: {
    lockFile: string;
    timeoutMs: number;
    contentionMessage: string;
    failureCode: string;
  },
  operation: () => T,
): T {
  const db = new DatabaseSync(input.lockFile);
  let transactionActive = false;
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(input.timeoutMs))};`);
    db.exec('BEGIN IMMEDIATE;');
    transactionActive = true;
    const result = operation();
    db.exec('COMMIT;');
    transactionActive = false;
    return result;
  } catch (error) {
    if (transactionActive) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Preserve the original state operation failure.
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/busy|locked/i.test(message)) {
      throw new FrameworkContractError(
        'runtime_state_lock_timeout',
        input.contentionMessage,
        {
          lock_path: input.lockFile,
          failure_code: input.failureCode,
        },
      );
    }
    throw error;
  } finally {
    db.close();
  }
}
