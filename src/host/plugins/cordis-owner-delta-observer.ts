import { Context } from '@deepseek-ai/cordis';

import {
  buildCordisPluginDescriptor,
  type CordisPluginDescriptor,
} from '../../authority/packages/index.ts';
import {
  buildCurrentOwnerDeltaTopline,
  type OwnerDeltaObservationInput,
  type OwnerDeltaObserverService,
  type OwnerDeltaTopline,
} from '../../authority/evidence/index.ts';

export const CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_ID = 'opl-ledger-owner-delta-observer';
export const CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_OWNER_DELTA_OBSERVER_SERVICE = 'opl.ledger.owner-delta-observer';
export const CORDIS_OWNER_DELTA_OBSERVER_SOURCE_REF =
  'src/host/plugins/cordis-owner-delta-observer.ts';
export const CORDIS_OWNER_DELTA_OBSERVER_SOURCE_COMMIT =
  'a896276b27b9f4ccfcf4e48ed636061d131094ae';

const ledgerAuthorityBoundary = Object.freeze([
  'app_product_truth',
  'domain_quality_verdict',
  'domain_truth',
  'ledger_evidence_persistence',
  'ledger_receipt_authority',
  'package_currentness',
  'package_installed_truth',
  'workspace_binding_registry',
  'workspace_file_bytes',
]);

export type CordisOwnerDeltaObservationInput = OwnerDeltaObservationInput;
export type CordisOwnerDeltaTopline = OwnerDeltaTopline;
export type CordisOwnerDeltaObserverService = OwnerDeltaObserverService;

declare module '@deepseek-ai/cordis' {
  interface Context {
    [CORDIS_OWNER_DELTA_OBSERVER_SERVICE]: CordisOwnerDeltaObserverService;
  }

  interface Events {
    'opl/ledger/owner-delta/observed': (topline: CordisOwnerDeltaTopline) => void;
  }
}

export const cordisOwnerDeltaObserverPlugin = {
  name: CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_ID,
  provide: CORDIS_OWNER_DELTA_OBSERVER_SERVICE,
  apply(ctx: Context) {
    const service: CordisOwnerDeltaObserverService = {
      observe(input) {
        const topline = buildCurrentOwnerDeltaTopline(input);
        ctx.emit('opl/ledger/owner-delta/observed', topline);
        return topline;
      },
    };
    ctx.provide(CORDIS_OWNER_DELTA_OBSERVER_SERVICE, service);
  },
};

export const CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_DESCRIPTOR: CordisPluginDescriptor =
  buildCordisPluginDescriptor({
    plugin_id: CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_ID,
    plugin_api_version: CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_API_VERSION,
    source_ref: CORDIS_OWNER_DELTA_OBSERVER_SOURCE_REF,
    source_commit: CORDIS_OWNER_DELTA_OBSERVER_SOURCE_COMMIT,
    package_ref: null,
    required: true,
    provides: [CORDIS_OWNER_DELTA_OBSERVER_SERVICE],
    injects: { required: [], optional: [] },
    events: [{
      name: 'opl/ledger/owner-delta/observed',
      mode: 'emit',
      role: 'publish',
      payload_schema_ref: null,
    }],
    scope: 'session',
    trust: 'first_party_restricted',
    disposer: { required: true, boundary: 'plugin_fiber' },
    authority_boundary: { forbidden_authorities: ledgerAuthorityBoundary },
  });

export const CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_DESCRIPTORS: readonly CordisPluginDescriptor[] =
  Object.freeze([CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_DESCRIPTOR]);

export async function createCordisOwnerDeltaObserverComposition() {
  const ctx = new Context();
  const fiber = await ctx.plugin(cordisOwnerDeltaObserverPlugin);
  return {
    ctx,
    fiber,
    observer: ctx[CORDIS_OWNER_DELTA_OBSERVER_SERVICE],
    async dispose() {
      await fiber.dispose();
      await ctx.fiber.dispose();
    },
  };
}
