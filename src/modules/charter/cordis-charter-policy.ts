import { Context } from '@deepseek-ai/cordis';

import type {
  FrameworkContracts,
  FrameworkContractsLoadOptions,
} from '../../kernel/types.ts';
import { loadFrameworkContracts } from './contracts.ts';

export const CORDIS_CHARTER_POLICY_PLUGIN_ID = 'opl-charter-policy';
export const CORDIS_CHARTER_POLICY_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_CHARTER_CONTRACTS_SERVICE = 'opl.charter.contracts';
export const CORDIS_CHARTER_POLICY_SOURCE_REF =
  'src/modules/charter/cordis-charter-policy.ts';
export const CORDIS_CHARTER_POLICY_SOURCE_COMMIT =
  '2410433106197e16e59697599ed95e95cdb0de4b';

export type CordisCharterPolicyService = {
  load(input?: string | FrameworkContractsLoadOptions): FrameworkContracts;
};

declare module '@deepseek-ai/cordis' {
  interface Context {
    [CORDIS_CHARTER_CONTRACTS_SERVICE]: CordisCharterPolicyService;
  }

  interface Events {
    'opl/charter/contracts/loaded': (contracts: FrameworkContracts) => void;
  }
}

export const cordisCharterPolicyPlugin = {
  name: CORDIS_CHARTER_POLICY_PLUGIN_ID,
  provide: CORDIS_CHARTER_CONTRACTS_SERVICE,
  apply(ctx: Context) {
    const service: CordisCharterPolicyService = {
      load(input) {
        const contracts = loadFrameworkContracts(input);
        ctx.emit('opl/charter/contracts/loaded', contracts);
        return contracts;
      },
    };
    ctx.provide(CORDIS_CHARTER_CONTRACTS_SERVICE, service);
  },
};

export const CORDIS_CHARTER_POLICY_PLUGIN_DESCRIPTOR = Object.freeze({
  descriptor_version: 'cordis-plugin-descriptor.v1',
  id: CORDIS_CHARTER_POLICY_PLUGIN_ID,
  plugin_id: CORDIS_CHARTER_POLICY_PLUGIN_ID,
  plugin_ref: `cordis:plugin:${CORDIS_CHARTER_POLICY_PLUGIN_ID}@${CORDIS_CHARTER_POLICY_PLUGIN_API_VERSION}`,
  plugin_api_version: CORDIS_CHARTER_POLICY_PLUGIN_API_VERSION,
  source_ref: CORDIS_CHARTER_POLICY_SOURCE_REF,
  source_commit: CORDIS_CHARTER_POLICY_SOURCE_COMMIT,
  source_identity: `git:${CORDIS_CHARTER_POLICY_SOURCE_COMMIT}:${CORDIS_CHARTER_POLICY_SOURCE_REF}`,
  package_ref: null,
  required: true,
  provides: [CORDIS_CHARTER_CONTRACTS_SERVICE],
  injects: { required: [], optional: [] },
  events: [{
    name: 'opl/charter/contracts/loaded',
    mode: 'emit',
    role: 'publish',
    payload_schema_ref: null,
  }],
  scope: 'process',
  trust: 'first_party_privileged',
  disposer: { required: true, boundary: 'plugin_fiber' },
  authority_boundary: {
    forbidden_authorities: [
      'app_product_truth',
      'domain_quality_verdict',
      'domain_truth',
      'package_installed_truth',
    ],
  },
} as const);
