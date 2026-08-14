import { Context } from '@deepseek-ai/cordis';

import {
  resolveStandardAgentStageQualityRuntimeBinding,
  type StandardAgentStageQualityRuntimeBinding,
} from './standard-agent-stage-manifest.ts';
import {
  CORDIS_STAGECRAFT_CONTEXT_SERVICE,
  type CordisStagecraftContextService,
} from '../stagecraft/index.ts';

export const CORDIS_PACK_STAGE_BINDING_PLUGIN_ID = 'opl-pack-stage-binding';
export const CORDIS_PACK_STAGE_BINDING_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_PACK_STAGE_BINDING_SERVICE = 'opl.pack.stage-binding';
export const CORDIS_PACK_STAGE_BINDING_SOURCE_REF =
  'src/modules/pack/cordis-pack-stage-binding-plugin.ts';
export const CORDIS_PACK_STAGE_BINDING_SOURCE_COMMIT =
  '3d91c10ea8c6d7a2f8de2a39e79e40b3f7d9d1b4';

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
