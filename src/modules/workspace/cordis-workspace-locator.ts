import { Context } from '@deepseek-ai/cordis';

import {
  buildCordisPluginDescriptor,
  type CordisPluginDescriptor,
} from '../pack/index.ts';
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
  '1499a9234c0de28b76d2ef2905572e4e6faba276';

const workspaceAuthorityBoundary = Object.freeze([
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

export const CORDIS_WORKSPACE_LOCATOR_PLUGIN_DESCRIPTOR: CordisPluginDescriptor =
  buildCordisPluginDescriptor({
    plugin_id: CORDIS_WORKSPACE_LOCATOR_PLUGIN_ID,
    plugin_api_version: CORDIS_WORKSPACE_LOCATOR_PLUGIN_API_VERSION,
    source_ref: CORDIS_WORKSPACE_LOCATOR_SOURCE_REF,
    source_commit: CORDIS_WORKSPACE_LOCATOR_SOURCE_COMMIT,
    package_ref: null,
    required: true,
    provides: [CORDIS_WORKSPACE_LOCATOR_SERVICE],
    injects: { required: [], optional: [] },
    events: [{
      name: 'opl/workspace/locator/resolved',
      mode: 'emit',
      role: 'publish',
      payload_schema_ref: null,
    }],
    scope: 'composition',
    trust: 'first_party_privileged',
    disposer: { required: true, boundary: 'plugin_fiber' },
    authority_boundary: { forbidden_authorities: workspaceAuthorityBoundary },
  });

export const CORDIS_WORKSPACE_LOCATOR_PLUGIN_DESCRIPTORS: readonly CordisPluginDescriptor[] =
  Object.freeze([CORDIS_WORKSPACE_LOCATOR_PLUGIN_DESCRIPTOR]);

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
