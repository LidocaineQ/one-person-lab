import { Context } from '@deepseek-ai/cordis';

import {
  buildCordisCompositionSnapshot,
  CordisCompositionContractError,
  type CordisCompositionSnapshot,
} from '../pack/index.ts';
import {
  CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_DESCRIPTOR,
  CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_ID,
  CORDIS_OWNER_DELTA_OBSERVER_SERVICE,
  cordisOwnerDeltaObserverPlugin,
  type CordisOwnerDeltaObserverService,
} from '../ledger/index.ts';
import {
  CORDIS_WORKSPACE_LOCATOR_PLUGIN_DESCRIPTOR,
  CORDIS_WORKSPACE_LOCATOR_PLUGIN_ID,
  CORDIS_WORKSPACE_LOCATOR_SERVICE,
  cordisWorkspaceLocatorPlugin,
  type CordisWorkspaceLocatorService,
} from '../workspace/index.ts';

export type { CordisOwnerDeltaObserverService } from '../ledger/index.ts';
export type { CordisWorkspaceLocatorService } from '../workspace/index.ts';

export const CORDIS_WORKSPACE_LEDGER_COMPOSITION_ID = 'opl-workspace-ledger-composition';
export const CORDIS_WORKSPACE_LEDGER_PLUGIN_DESCRIPTORS = Object.freeze([
  CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_DESCRIPTOR,
  CORDIS_WORKSPACE_LOCATOR_PLUGIN_DESCRIPTOR,
]);

const CORDIS_FRAMEWORK_PACKAGE = '@deepseek-ai/cordis';
const CORDIS_FRAMEWORK_VERSION = '4.0.1';
const CORDIS_FRAMEWORK_INTEGRITY =
  'sha512-YBdskTU2Po1kru3GgcUWUbkTsPMA9LkSQDAY8rBkFJeajdgcQad3QPJZE26JyK99Xb6HaASvoXg2DSUTeN/0Nw==';

export type CordisWorkspaceLedgerComposition = {
  ctx: Context;
  workspaceLocator: CordisWorkspaceLocatorService;
  ownerDeltaObserver: CordisOwnerDeltaObserverService;
  snapshot: CordisCompositionSnapshot;
  dispose(): Promise<void>;
};

export function buildCordisWorkspaceLedgerCompositionSnapshot(): CordisCompositionSnapshot {
  return buildCordisCompositionSnapshot({
    framework: {
      package: CORDIS_FRAMEWORK_PACKAGE,
      version: CORDIS_FRAMEWORK_VERSION,
      integrity: CORDIS_FRAMEWORK_INTEGRITY,
    },
    binding: {
      executor_adapter_id: CORDIS_WORKSPACE_LOCATOR_SERVICE,
      executor_route: CORDIS_OWNER_DELTA_OBSERVER_SERVICE,
    },
    foundry_evidence_ref: null,
    plugins: CORDIS_WORKSPACE_LEDGER_PLUGIN_DESCRIPTORS,
  });
}

export async function createCordisWorkspaceLedgerComposition(options: {
  mountWorkspaceLocator?: boolean;
  mountOwnerDeltaObserver?: boolean;
} = {}): Promise<CordisWorkspaceLedgerComposition> {
  const ctx = new Context();
  let workspaceFiber: Awaited<ReturnType<Context['plugin']>> | null = null;
  let observerFiber: Awaited<ReturnType<Context['plugin']>> | null = null;
  try {
    workspaceFiber = options.mountWorkspaceLocator === false
      ? null
      : await ctx.plugin(cordisWorkspaceLocatorPlugin);
    observerFiber = options.mountOwnerDeltaObserver === false
      ? null
      : await ctx.plugin(cordisOwnerDeltaObserverPlugin);
    const workspaceLocator = ctx.get(CORDIS_WORKSPACE_LOCATOR_SERVICE);
    const ownerDeltaObserver = ctx.get(CORDIS_OWNER_DELTA_OBSERVER_SERVICE);
    if (!workspaceLocator || !ownerDeltaObserver) {
      const pluginId = !workspaceLocator
        ? CORDIS_WORKSPACE_LOCATOR_PLUGIN_ID
        : CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_ID;
      const serviceId = !workspaceLocator
        ? CORDIS_WORKSPACE_LOCATOR_SERVICE
        : CORDIS_OWNER_DELTA_OBSERVER_SERVICE;
      throw new CordisCompositionContractError(
        'missing_required_provider',
        'Cordis Workspace/Ledger composition is missing a required service provider.',
        { plugin_id: pluginId, service_id: serviceId },
      );
    }
    return {
      ctx,
      workspaceLocator,
      ownerDeltaObserver,
      snapshot: buildCordisWorkspaceLedgerCompositionSnapshot(),
      async dispose() {
        await observerFiber?.dispose();
        await workspaceFiber?.dispose();
        await ctx.fiber.dispose();
      },
    };
  } catch (error) {
    await observerFiber?.dispose();
    await workspaceFiber?.dispose();
    await ctx.fiber.dispose();
    throw error;
  }
}
