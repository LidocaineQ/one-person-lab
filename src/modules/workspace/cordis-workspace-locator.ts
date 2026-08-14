import { Context } from '@deepseek-ai/cordis';

import {
  getActiveWorkspaceBinding,
  listWorkspaceBindings,
  resolveWorkspaceLocator,
} from './workspace-registry.ts';
import type { WorkspaceBinding } from '../../kernel/workspace-binding-port.ts';

export const CORDIS_WORKSPACE_LOCATOR_PLUGIN_ID = 'opl-workspace-locator';
export const CORDIS_WORKSPACE_LOCATOR_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_WORKSPACE_LOCATOR_SERVICE = 'opl.workspace.locator';
export const CORDIS_WORKSPACE_LOCATOR_SOURCE_REF =
  'src/modules/workspace/cordis-workspace-locator.ts';
export const CORDIS_WORKSPACE_LOCATOR_SOURCE_COMMIT =
  '84f914171bbc1424c372b34131b4c0298120660e';

export type CordisWorkspaceLocator = ReturnType<typeof resolveWorkspaceLocator>;

export type CordisWorkspaceLocatorService = {
  resolve(projectId: string, explicitWorkspacePath?: string): CordisWorkspaceLocator;
  active(projectId: string): WorkspaceBinding | null;
  list(): WorkspaceBinding[];
};

declare module '@deepseek-ai/cordis' {
  interface Context {
    [CORDIS_WORKSPACE_LOCATOR_SERVICE]: CordisWorkspaceLocatorService;
  }

  interface Events {
    'opl/workspace/locator/resolved': (locator: CordisWorkspaceLocator) => void;
  }
}

export const cordisWorkspaceLocatorPlugin = {
  name: CORDIS_WORKSPACE_LOCATOR_PLUGIN_ID,
  provide: CORDIS_WORKSPACE_LOCATOR_SERVICE,
  apply(ctx: Context) {
    const service: CordisWorkspaceLocatorService = {
      resolve(projectId, explicitWorkspacePath) {
        const locator = resolveWorkspaceLocator(projectId, explicitWorkspacePath);
        ctx.emit('opl/workspace/locator/resolved', locator);
        return locator;
      },
      active(projectId) {
        return getActiveWorkspaceBinding(projectId);
      },
      list() {
        return listWorkspaceBindings();
      },
    };
    ctx.provide(CORDIS_WORKSPACE_LOCATOR_SERVICE, service);
  },
};

export async function createCordisWorkspaceLocatorComposition() {
  const ctx = new Context();
  const fiber = await ctx.plugin(cordisWorkspaceLocatorPlugin);
  return {
    ctx,
    fiber,
    locator: ctx[CORDIS_WORKSPACE_LOCATOR_SERVICE],
    async dispose() {
      await fiber.dispose();
      await ctx.fiber.dispose();
    },
  };
}
