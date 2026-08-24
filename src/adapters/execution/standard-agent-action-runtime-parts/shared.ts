import crypto from 'node:crypto';

import { FrameworkContractError } from '../../../kernel/contract-validation.ts';

export function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new FrameworkContractError('contract_shape_invalid', message, details);
}

export function sha256(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
