import path from 'node:path';

import {
  commandFailure,
  parseMarketplaceList,
  marketplaceName,
} from './configured-codex-plugin-carrier-native.ts';
import { sameMarketplaceSource } from './shared.ts';
import type {
  ConfiguredCodexPluginCarrierAction,
  CodexPluginCommandRunner,
} from './configured-codex-plugin-carrier-types.ts';

function ensureMarketplaceArgs(source: string) {
  return ['plugin', 'marketplace', 'add', source, '--json'];
}
export function ensureMarketplaceAvailable(input: {
  packageId: string;
  action: ConfiguredCodexPluginCarrierAction;
  pluginId: string;
  marketplaceSource: string;
  binary: string;
  env: NodeJS.ProcessEnv;
  runner: CodexPluginCommandRunner;
}) {
  const marketplaceListArgs = ['plugin', 'marketplace', 'list', '--json'];
  const marketplaceList = input.runner({
    binary: input.binary,
    args: marketplaceListArgs,
    env: input.env,
  });
  const marketplaces = marketplaceList.status === 0 && !marketplaceList.error
    ? parseMarketplaceList(marketplaceList.stdout, input.packageId)
    : [];
  const configuredMarketplace = marketplaces
    .find((entry) => sameMarketplaceSource(entry.marketplaceSource, input.marketplaceSource)) ?? null;
  if (configuredMarketplace) {
    if ((input.action !== 'update' && input.action !== 'repair')
      || configuredMarketplace.sourceType !== 'git') return;
    const upgradeArgs = [
      'plugin', 'marketplace', 'upgrade',
      configuredMarketplace.name ?? marketplaceName(input.pluginId),
      '--json',
    ];
    const upgradeResult = input.runner({
      binary: input.binary,
      args: upgradeArgs,
      env: input.env,
    });
    if (upgradeResult.status !== 0 || upgradeResult.error) {
      commandFailure({
        packageId: input.packageId,
        action: input.action,
        args: upgradeArgs,
        result: upgradeResult,
      });
    }
    return;
  }

  const expectedMarketplaceName = marketplaceName(input.pluginId);
  const replacedMarketplace = path.isAbsolute(input.marketplaceSource)
    ? marketplaces.find((entry) => (
      entry.name === expectedMarketplaceName
      && entry.sourceType === 'git'
      && entry.marketplaceSource
      && !sameMarketplaceSource(entry.marketplaceSource, input.marketplaceSource)
    )) ?? null
    : null;
  if (replacedMarketplace) {
    const removeArgs = ['plugin', 'marketplace', 'remove', expectedMarketplaceName, '--json'];
    const removeResult = input.runner({
      binary: input.binary,
      args: removeArgs,
      env: input.env,
    });
    if (removeResult.status !== 0 || removeResult.error) {
      commandFailure({
        packageId: input.packageId,
        action: input.action,
        args: removeArgs,
        result: removeResult,
      });
    }
  }

  const marketplaceArgs = ensureMarketplaceArgs(input.marketplaceSource);
  const marketplaceResult = input.runner({
    binary: input.binary,
    args: marketplaceArgs,
    env: input.env,
  });
  if (marketplaceResult.status !== 0 || marketplaceResult.error) {
    if (replacedMarketplace?.marketplaceSource) {
      input.runner({
        binary: input.binary,
        args: ensureMarketplaceArgs(replacedMarketplace.marketplaceSource),
        env: input.env,
      });
    }
    commandFailure({
      packageId: input.packageId,
      action: input.action,
      args: marketplaceArgs,
      result: marketplaceResult,
    });
  }
}
