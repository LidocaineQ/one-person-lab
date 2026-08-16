import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import {
  discoverInstalledPackageDescriptors,
  type InstalledPackageDescriptor,
} from './installed-codex-plugin-directory.ts';
import type { CodexPluginCommandRunner } from './configured-codex-plugin-carrier.ts';
import type { AgentPackageRuntimeModuleBinding } from './types.ts';

export type InstalledPackageRuntimeDiscoveryOptions = {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CodexPluginCommandRunner;
};

export type InstalledPackageRuntimeModuleInput = InstalledPackageRuntimeDiscoveryOptions & {
  packageId: string;
  moduleKind: string;
  adapterAbi: string;
};

export type InstalledPackageRuntimeModuleContext = {
  descriptor: InstalledPackageDescriptor;
  binding: AgentPackageRuntimeModuleBinding;
  modulePath: string;
  readJson: (relativePath: string) => Record<string, unknown>;
};

export type LoadedInstalledPackageRuntimeModule = InstalledPackageRuntimeModuleContext & {
  module: Record<string, unknown>;
  handler: (request: unknown) => unknown;
};

function packagePathError(
  descriptor: InstalledPackageDescriptor,
  relativePath: string,
  reasonCode: string,
  message: string,
): FrameworkContractError {
  return new FrameworkContractError('codex_command_failed', message, {
    package_id: descriptor.manifest.package_id,
    source_path: descriptor.sourcePath,
    relative_path: relativePath,
    reason_code: reasonCode,
  });
}

function lockedPackagePath(
  descriptor: InstalledPackageDescriptor,
  relativePath: string,
  role: string,
): string {
  const contentLockPaths = descriptor.manifest.content_lock_paths ?? [];
  if (!contentLockPaths.includes(relativePath)) {
    throw packagePathError(
      descriptor,
      relativePath,
      'installed_runtime_module_path_unlocked',
      `Installed Package runtime module ${role} is outside its content lock.`,
    );
  }
  const packageRoot = path.resolve(descriptor.sourcePath);
  const candidate = path.resolve(packageRoot, relativePath);
  if (candidate === packageRoot || !candidate.startsWith(`${packageRoot}${path.sep}`)) {
    throw packagePathError(
      descriptor,
      relativePath,
      'installed_runtime_module_path_escapes_package',
      `Installed Package runtime module ${role} escapes its package root.`,
    );
  }
  let realPackageRoot: string;
  let realCandidate: string;
  try {
    realPackageRoot = fs.realpathSync.native(packageRoot);
    realCandidate = fs.realpathSync.native(candidate);
  } catch (error) {
    throw new FrameworkContractError('codex_command_failed', `Installed Package runtime module ${role} is unavailable.`, {
      package_id: descriptor.manifest.package_id,
      source_path: descriptor.sourcePath,
      relative_path: relativePath,
      reason_code: 'installed_runtime_module_path_unavailable',
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (realCandidate === realPackageRoot || !realCandidate.startsWith(`${realPackageRoot}${path.sep}`)) {
    throw packagePathError(
      descriptor,
      relativePath,
      'installed_runtime_module_path_symlink_escape',
      `Installed Package runtime module ${role} escapes its package root through a link.`,
    );
  }
  try {
    if (!fs.statSync(realCandidate).isFile()) throw new Error('not a file');
  } catch (error) {
    throw new FrameworkContractError('codex_command_failed', `Installed Package runtime module ${role} is unavailable.`, {
      package_id: descriptor.manifest.package_id,
      source_path: descriptor.sourcePath,
      relative_path: relativePath,
      reason_code: 'installed_runtime_module_path_unavailable',
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return realCandidate;
}

function bindingPathRefs(binding: AgentPackageRuntimeModuleBinding) {
  return [
    binding.handler.file,
    binding.profile_ref,
    binding.profile_schema_ref,
    binding.registry_ref,
    binding.registry_schema_ref,
    binding.step_schema_ref,
    ...binding.contained_implementation_files,
  ];
}

function contentLockDigest(descriptor: InstalledPackageDescriptor): string {
  const canonicalization = descriptor.manifest.content_lock_canonicalization;
  const declaredDigest = descriptor.manifest.content_digest;
  const contentLockPaths = descriptor.manifest.content_lock_paths ?? [];
  if (!canonicalization || !declaredDigest || contentLockPaths.length === 0) {
    throw new FrameworkContractError('codex_command_failed', 'Installed Package runtime module content lock is incomplete.', {
      package_id: descriptor.manifest.package_id,
      source_path: descriptor.sourcePath,
      reason_code: 'installed_runtime_module_content_lock_missing',
    });
  }
  const digest = crypto.createHash('sha256');
  for (const relativePath of contentLockPaths) {
    const filePath = lockedPackagePath(descriptor, relativePath, 'content lock file');
    const fileBytes = fs.readFileSync(filePath);
    const pathBytes = Buffer.from(relativePath, 'utf8');
    if (canonicalization === 'ordered_path_nul_file_bytes') {
      digest.update(pathBytes);
      digest.update(Buffer.from([0]));
      digest.update(fileBytes);
      continue;
    }
    if (canonicalization !== 'ordered_path_length_file_length_bytes') {
      throw new FrameworkContractError('codex_command_failed', 'Installed Package runtime module content lock canonicalization is unsupported.', {
        package_id: descriptor.manifest.package_id,
        content_lock_canonicalization: canonicalization,
        reason_code: 'installed_runtime_module_content_lock_invalid',
      });
    }
    const pathLength = Buffer.allocUnsafe(8);
    const fileLength = Buffer.allocUnsafe(8);
    pathLength.writeBigUInt64BE(BigInt(pathBytes.length));
    fileLength.writeBigUInt64BE(BigInt(fileBytes.length));
    digest.update(pathLength);
    digest.update(pathBytes);
    digest.update(fileLength);
    digest.update(fileBytes);
  }
  const actualDigest = `sha256:${digest.digest('hex')}`;
  if (actualDigest !== declaredDigest) {
    throw new FrameworkContractError('codex_command_failed', 'Installed Package runtime module content lock does not match its source bytes.', {
      package_id: descriptor.manifest.package_id,
      source_path: descriptor.sourcePath,
      expected_content_digest: declaredDigest,
      actual_content_digest: actualDigest,
      reason_code: 'installed_runtime_module_content_lock_mismatch',
    });
  }
  return actualDigest;
}

function resolveBinding(input: InstalledPackageRuntimeModuleInput): InstalledPackageRuntimeModuleContext {
  const descriptors = discoverInstalledPackageDescriptors({
    packageId: input.packageId,
    binary: input.binary,
    env: input.env,
    runner: input.runner,
    failClosedOnCarrierError: true,
  });
  const descriptor = descriptors.get(input.packageId);
  if (!descriptor) {
    throw new FrameworkContractError('codex_command_failed', 'Required installed Package descriptor is unavailable.', {
      package_id: input.packageId,
      reason_code: 'installed_package_descriptor_missing',
    });
  }
  if (
    !descriptor.enabled
    || !descriptor.carrier_readback.enabled
    || !descriptor.readiness.installed
    || descriptor.readiness.physical_status !== 'available'
    || descriptor.readiness.callability !== 'callable'
  ) {
    throw new FrameworkContractError('codex_command_failed', 'Required installed Package descriptor is not callable.', {
      package_id: input.packageId,
      enabled: descriptor.enabled,
      readiness: descriptor.readiness,
      reason_code: 'installed_package_descriptor_not_callable',
    });
  }
  contentLockDigest(descriptor);
  const matchingBindings = descriptor.manifest.runtime_module_bindings.filter((binding) => (
    binding.module_kind === input.moduleKind
    && binding.adapter_abi === input.adapterAbi
  ));
  if (matchingBindings.length !== 1) {
    throw new FrameworkContractError('codex_command_failed', 'Installed Package does not expose exactly one requested runtime module binding.', {
      package_id: input.packageId,
      module_kind: input.moduleKind,
      adapter_abi: input.adapterAbi,
      matching_module_ids: matchingBindings.map((binding) => binding.module_id),
      declared_module_ids: descriptor.manifest.runtime_module_bindings.map((binding) => binding.module_id),
      reason_code: matchingBindings.length === 0
        ? 'installed_runtime_module_binding_missing'
        : 'installed_runtime_module_binding_ambiguous',
    });
  }
  const binding = matchingBindings[0]!;
  const contentLockPaths = descriptor.manifest.content_lock_paths ?? [];
  const unlockedPaths = [...new Set(bindingPathRefs(binding).filter((relativePath) => (
    !contentLockPaths.includes(relativePath)
  )))];
  if (unlockedPaths.length > 0) {
    throw new FrameworkContractError('codex_command_failed', 'Installed runtime module binding contains paths outside its content lock.', {
      package_id: input.packageId,
      module_id: binding.module_id,
      unlocked_paths: unlockedPaths,
      reason_code: 'installed_runtime_module_path_unlocked',
    });
  }
  const modulePath = lockedPackagePath(descriptor, binding.handler.file, 'handler');
  const readJson = (relativePath: string) => {
    const filePath = lockedPackagePath(descriptor, relativePath, 'descriptor reference');
    try {
      const payload = parseJsonText(fs.readFileSync(filePath, 'utf8')) as unknown;
      if (!isRecord(payload)) throw new Error('expected a JSON object');
      return payload;
    } catch (error) {
      if (error instanceof FrameworkContractError) throw error;
      throw new FrameworkContractError('codex_command_failed', 'Installed Package runtime module reference is not valid JSON.', {
        package_id: input.packageId,
        module_id: binding.module_id,
        relative_path: relativePath,
        reason_code: 'installed_runtime_module_reference_invalid',
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return { descriptor, binding, modulePath, readJson };
}

export function resolveInstalledPackageRuntimeModule(
  input: InstalledPackageRuntimeModuleInput,
): InstalledPackageRuntimeModuleContext {
  return resolveBinding(input);
}

export async function loadInstalledPackageRuntimeModule(
  input: InstalledPackageRuntimeModuleInput,
): Promise<LoadedInstalledPackageRuntimeModule> {
  const context = resolveBinding(input);
  let module: Record<string, unknown>;
  try {
    module = await import(pathToFileURL(context.modulePath).href) as Record<string, unknown>;
  } catch (error) {
    throw new FrameworkContractError('codex_command_failed', 'Installed Package runtime module could not be loaded.', {
      package_id: input.packageId,
      module_id: context.binding.module_id,
      module_path: context.binding.handler.file,
      handler_ref: `${context.binding.handler.file}#${context.binding.handler.export}`,
      reason_code: 'installed_runtime_module_load_failed',
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const handler = module[context.binding.handler.export];
  if (typeof handler !== 'function') {
    throw new FrameworkContractError('codex_command_failed', 'Installed Package runtime module handler export is missing.', {
      package_id: input.packageId,
      module_id: context.binding.module_id,
      module_path: context.binding.handler.file,
      handler_export: context.binding.handler.export,
      reason_code: 'installed_runtime_module_handler_missing',
    });
  }
  return {
    ...context,
    module,
    handler: handler as (request: unknown) => unknown,
  };
}
