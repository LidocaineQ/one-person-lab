import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertChannelProvider,
  type ChannelProvider,
} from '../../../authority/packages/index.ts';
import type {
  InstalledPackageDescriptor,
} from '../agent-package-registry-parts/installed-codex-plugin-directory.ts';
import type {
  ChannelProviderPackageEntrypoint,
} from '../agent-package-registry-parts/channel-provider-entrypoint-contract.ts';

function channelProviderEntrypoints(
  descriptor: InstalledPackageDescriptor,
): ChannelProviderPackageEntrypoint[] {
  return descriptor.manifest.entrypoints.flatMap((entry) => {
    if (entry.kind !== 'channel_provider') return [];
    if (
      typeof entry.entrypoint_id !== 'string'
      || typeof entry.module_ref !== 'string'
      || typeof entry.export_name !== 'string'
    ) {
      throw new Error(
        `Installed Package ${descriptor.manifest.package_id} has an invalid channel provider entrypoint.`,
      );
    }
    return [entry as ChannelProviderPackageEntrypoint];
  }).sort((left, right) => left.entrypoint_id.localeCompare(right.entrypoint_id));
}

function resolveEntrypointModule(
  descriptor: InstalledPackageDescriptor,
  entrypoint: ChannelProviderPackageEntrypoint,
) {
  if (!descriptor.manifest.content_lock_paths?.includes(entrypoint.module_ref)) {
    throw new Error(
      `Channel provider entrypoint is outside the Package content lock: ${descriptor.manifest.package_id}:${entrypoint.module_ref}`,
    );
  }
  const packageRoot = path.resolve(descriptor.sourcePath);
  const modulePath = path.resolve(packageRoot, entrypoint.module_ref);
  if (modulePath === packageRoot || !modulePath.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error(
      `Channel provider entrypoint escapes the installed Package: ${descriptor.manifest.package_id}:${entrypoint.module_ref}`,
    );
  }
  try {
    if (!fs.statSync(modulePath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(
      `Channel provider entrypoint is unavailable: ${descriptor.manifest.package_id}:${entrypoint.module_ref}`,
    );
  }
  return modulePath;
}

function isCallable(descriptor: InstalledPackageDescriptor) {
  return descriptor.enabled
    && descriptor.carrier_readback.enabled
    && descriptor.readiness.installed
    && descriptor.readiness.physical_status === 'available'
    && descriptor.readiness.callability === 'callable';
}

function createChannelProvider(
  descriptor: InstalledPackageDescriptor,
  entrypoint: ChannelProviderPackageEntrypoint,
  exported: unknown,
): ChannelProvider {
  if (typeof exported !== 'function' || exported.length !== 0) {
    throw new TypeError(
      `Channel provider entrypoint must export a zero-argument factory: ${descriptor.manifest.package_id}:${entrypoint.export_name}`,
    );
  }
  const candidate = Reflect.apply(exported, undefined, []);
  if (
    candidate !== null
    && (typeof candidate === 'object' || typeof candidate === 'function')
    && typeof (candidate as { then?: unknown }).then === 'function'
  ) {
    void Promise.resolve(candidate).catch(() => undefined);
    throw new TypeError(
      `Channel provider factory must return synchronously: ${descriptor.manifest.package_id}:${entrypoint.export_name}`,
    );
  }
  assertChannelProvider(candidate);
  return candidate;
}

export async function loadInstalledChannelProviders(
  descriptors: Iterable<InstalledPackageDescriptor>,
): Promise<readonly ChannelProvider[]> {
  const providers: ChannelProvider[] = [];
  const providerIds = new Set<string>();
  const callableDescriptors = [...descriptors]
    .filter(isCallable)
    .sort((left, right) => left.manifest.package_id.localeCompare(right.manifest.package_id));
  for (const descriptor of callableDescriptors) {
    for (const entrypoint of channelProviderEntrypoints(descriptor)) {
      const modulePath = resolveEntrypointModule(descriptor, entrypoint);
      const module = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
      const provider = createChannelProvider(
        descriptor,
        entrypoint,
        module[entrypoint.export_name],
      );
      if (provider.provider_id !== descriptor.manifest.package_id) {
        throw new Error(
          `Channel provider identity must match its installed Package: ${descriptor.manifest.package_id}:${provider.provider_id}`,
        );
      }
      if (providerIds.has(provider.provider_id)) {
        throw new Error(`Channel provider identity is duplicated: ${provider.provider_id}`);
      }
      providerIds.add(provider.provider_id);
      providers.push(provider);
    }
  }
  return Object.freeze(providers);
}
