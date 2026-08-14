import { Context } from '@deepseek-ai/cordis';

import { buildCurrentOwnerDeltaTopline } from './current-owner-delta-topline.ts';

export const CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_ID = 'opl-ledger-owner-delta-observer';
export const CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_OWNER_DELTA_OBSERVER_SERVICE = 'opl.ledger.owner-delta-observer';
export const CORDIS_OWNER_DELTA_OBSERVER_SOURCE_REF =
  'src/modules/ledger/cordis-owner-delta-observer.ts';
export const CORDIS_OWNER_DELTA_OBSERVER_SOURCE_COMMIT =
  '84f914171bbc1424c372b34131b4c0298120660e';

export type CordisOwnerDeltaObservationInput = {
  currentOwnerDeltaReadModel: unknown;
};

export type CordisOwnerDeltaTopline = ReturnType<typeof buildCurrentOwnerDeltaTopline>;

export type CordisOwnerDeltaObserverService = {
  observe(input: CordisOwnerDeltaObservationInput): CordisOwnerDeltaTopline;
};

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
