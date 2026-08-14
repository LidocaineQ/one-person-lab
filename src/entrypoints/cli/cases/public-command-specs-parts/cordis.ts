import {
  buildCordisCompositionInspect,
  CORDIS_AGENT_EXECUTOR_INSPECT_METADATA,
  markCordisCompositionInspectDisposed,
} from '../../../../modules/console/index.ts';
import { createCordisAgentExecutorComposition } from '../../../../modules/runway/cordis-agent-executor-experiment.ts';
import { parseRegisteredCommandOptions } from '../../modules/support.ts';
import type { CommandSpec } from '../../modules/support.ts';

export function buildCordisCommandSpecs(): Record<string, CommandSpec> {
  const specs: Record<string, CommandSpec> = {
    'cordis inspect': {
      usage: 'opl cordis inspect',
      summary: 'Read the isolated Cordis composition, plugin lifecycle, service bindings, event modes, and teardown diagnostics without changing installed or domain truth.',
      examples: ['opl cordis inspect --json'],
      group: 'framework',
      handler: async (args) => {
        parseRegisteredCommandOptions('cordis inspect', args, specs['cordis inspect']);
        const composition = await createCordisAgentExecutorComposition();
        let inspect;
        try {
          inspect = buildCordisCompositionInspect({
            context: composition.ctx,
            snapshot: composition.snapshot,
            metadata: CORDIS_AGENT_EXECUTOR_INSPECT_METADATA,
          });
        } finally {
          await composition.dispose();
        }
        return markCordisCompositionInspectDisposed(inspect);
      },
    },
  };
  return specs;
}
