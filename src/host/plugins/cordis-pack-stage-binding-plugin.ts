import { Context } from '@deepseek-ai/cordis';

import {
  resolveStandardAgentStageQualityRuntimeBinding,
  type StandardAgentStageQualityRuntimeBinding,
} from '../../authority/packages/index.ts';
import {
  CORDIS_STAGECRAFT_CONTEXT_SERVICE,
  type CordisStagecraftContextService,
} from './cordis-stagecraft-context-plugin.ts';

export const CORDIS_PACK_STAGE_BINDING_PLUGIN_ID = 'opl-pack-stage-binding';
export const CORDIS_PACK_STAGE_BINDING_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_PACK_STAGE_BINDING_SERVICE = 'opl.pack.stage-binding';
export const CORDIS_PACK_STAGE_BINDING_SOURCE_REF =
  'src/host/plugins/cordis-pack-stage-binding-plugin.ts';
export const CORDIS_PACK_STAGE_BINDING_SOURCE_COMMIT =
  'b1bca04e9a77e6df4156d0858ecbb69566f6decd';

export type CordisPackStageBindingService = {
  resolve(
    repoDir: string,
    stageId: string,
  ): StandardAgentStageQualityRuntimeBinding | null;
};

declare module '@deepseek-ai/cordis' {
  interface Context {
    [CORDIS_PACK_STAGE_BINDING_SERVICE]: CordisPackStageBindingService;
  }

  interface Events {
    'opl/pack/stage-binding/resolved': (
      binding: StandardAgentStageQualityRuntimeBinding | null,
    ) => void;
  }
}

export const cordisPackStageBindingPlugin = {
  name: CORDIS_PACK_STAGE_BINDING_PLUGIN_ID,
  inject: [CORDIS_STAGECRAFT_CONTEXT_SERVICE],
  provide: CORDIS_PACK_STAGE_BINDING_SERVICE,
  apply(ctx: Context) {
    // The Stagecraft injection is a lifecycle dependency. Pack remains the sole
    // owner of the binding compiler and delegates to its existing implementation.
    void (ctx.get(CORDIS_STAGECRAFT_CONTEXT_SERVICE) as CordisStagecraftContextService);
    const service: CordisPackStageBindingService = {
      resolve(repoDir, stageId) {
        const binding = resolveStandardAgentStageQualityRuntimeBinding(repoDir, stageId);
        ctx.emit('opl/pack/stage-binding/resolved', binding);
        return binding;
      },
    };
    ctx.provide(CORDIS_PACK_STAGE_BINDING_SERVICE, service);
  },
};
