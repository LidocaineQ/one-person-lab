export const CORDIS_FRAMEWORK_PACKAGE = '@deepseek-ai/cordis';
export const CORDIS_FRAMEWORK_VERSION = '4.0.1';
export const CORDIS_FRAMEWORK_INTEGRITY =
  'sha512-YBdskTU2Po1kru3GgcUWUbkTsPMA9LkSQDAY8rBkFJeajdgcQad3QPJZE26JyK99Xb6HaASvoXg2DSUTeN/0Nw==';

// Cordis exposes fiber.state, while its const enum is erased from ESM output.
export const CORDIS_FIBER_STATE = {
  PENDING: 0,
  ACTIVE: 2,
} as const;

export const CORDIS_ABI_PACKAGE_REF = Object.freeze({
  package_id: '@one-person-lab/cordis-abi',
  package_version: '0.1.0',
  package_ref: 'npm:@one-person-lab/cordis-abi@0.1.0',
});
