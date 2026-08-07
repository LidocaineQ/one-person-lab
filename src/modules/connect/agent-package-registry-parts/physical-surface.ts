import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import { recordList, stringValue } from '../../../kernel/json-record.ts';
import type { BundledFullRuntimeCatalogEntry } from './bundled-full-runtime-catalog.ts';
import {
  admitPackagePayloadManifest,
  payloadFileMode,
  type PackagePayloadAdmission,
  verifyCanonicalPayloadContentLock,
} from './payload-manifest.ts';
import type {
  AgentPackageManifest,
  AgentPackagePayloadFile,
} from './types.ts';

function safeRelativePayloadPath(value: string) {
  const normalized = path.normalize(value);
  if (
    !value.trim()
    || path.isAbsolute(value)
    || normalized === '.'
    || normalized.startsWith(`..${path.sep}`)
    || normalized === '..'
  ) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package payload file paths must be relative package paths.', {
      payload_path: value,
      failure_code: 'agent_package_payload_path_invalid',
    });
  }
  return normalized;
}

function safeBundledSourceRoot(value: string) {
  if (value === '.') return value;
  return safeRelativePayloadPath(value);
}

function assertBundledPathComponentsAreReal(input: {
  rootPath: string;
  relativePath: string;
  payloadManifestUrl: string;
  payloadPath: string;
}) {
  let currentPath = input.rootPath;
  for (const segment of input.relativePath === '.' ? [] : input.relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    if (fs.lstatSync(currentPath).isSymbolicLink()) {
      throw new FrameworkContractError('contract_shape_invalid', 'Bundled Full runtime package payload paths must not contain symbolic links.', {
        payload_manifest_url: input.payloadManifestUrl,
        payload_path: input.payloadPath,
        symbolic_link_path: currentPath,
        failure_code: 'agent_package_bundled_payload_symlink_forbidden',
      });
    }
  }
}

function bundledPayloadFile(input: {
  packageRoot: string;
  sourceRoot: string;
  entry: Record<string, unknown>;
  payloadManifestUrl: string;
  index: number;
  admission: PackagePayloadAdmission;
}): AgentPackagePayloadFile {
  const relativePathValue = stringValue(input.entry.path);
  if (!relativePathValue) {
    throw new FrameworkContractError('contract_shape_invalid', 'Bundled package payload files require a path.', {
      payload_manifest_url: input.payloadManifestUrl,
      file_index: input.index,
      failure_code: 'agent_package_payload_manifest_invalid',
    });
  }
  const relativePath = safeRelativePayloadPath(relativePathValue);
  const sourceFilePath = path.resolve(input.packageRoot, input.sourceRoot, relativePath);
  const sourceRootPath = path.resolve(input.packageRoot, input.sourceRoot);
  if (!sourceFilePath.startsWith(`${sourceRootPath}${path.sep}`)
    || !fs.existsSync(sourceFilePath)
    || !fs.lstatSync(sourceFilePath).isFile()) {
    throw new FrameworkContractError('contract_shape_invalid', 'Bundled Full runtime package payload file is missing or is not a regular file.', {
      payload_manifest_url: input.payloadManifestUrl,
      payload_path: relativePath,
      source_file_path: sourceFilePath,
      failure_code: 'agent_package_bundled_payload_file_missing',
    });
  }
  const rootReal = fs.realpathSync(sourceRootPath);
  const fileReal = fs.realpathSync(sourceFilePath);
  if (!fileReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Bundled Full runtime package payload file escapes its packaged source root.', {
      payload_manifest_url: input.payloadManifestUrl,
      payload_path: relativePath,
      source_file_path: sourceFilePath,
      failure_code: 'agent_package_bundled_payload_path_escape',
    });
  }
  assertBundledPathComponentsAreReal({
    rootPath: sourceRootPath,
    relativePath,
    payloadManifestUrl: input.payloadManifestUrl,
    payloadPath: relativePath,
  });
  const content = fs.readFileSync(fileReal);
  const expectedDigest = stringValue(input.entry.sha256);
  const actualDigest = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  if (!expectedDigest || expectedDigest !== actualDigest) {
    throw new FrameworkContractError('contract_shape_invalid', 'Bundled Full runtime package payload file digest does not match its catalog payload.', {
      payload_manifest_url: input.payloadManifestUrl,
      payload_path: relativePath,
      expected_sha256: expectedDigest,
      actual_sha256: actualDigest,
      failure_code: 'agent_package_bundled_payload_file_sha256_mismatch',
    });
  }
  const mode = payloadFileMode(input.admission, input.entry);
  const expectedMode = mode === '100755' ? 0o755 : 0o644;
  const actualMode = fs.statSync(fileReal).mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new FrameworkContractError('contract_shape_invalid', 'Bundled Full runtime package payload file mode does not match its catalog payload.', {
      payload_manifest_url: input.payloadManifestUrl,
      payload_path: relativePath,
      expected_mode: mode,
      actual_mode: actualMode.toString(8).padStart(3, '0'),
      failure_code: 'agent_package_bundled_payload_file_mode_mismatch',
    });
  }
  return {
    relativePath,
    content,
    sha256: expectedDigest,
    mode,
    digestVerified: true,
  };
}

export function resolveBundledFullRuntimeManifestPhysicalSource(input: {
  manifest: AgentPackageManifest;
  catalogEntry: BundledFullRuntimeCatalogEntry;
  packageRoot: string;
}) {
  const packageRoot = path.resolve(input.packageRoot);
  if (!fs.existsSync(packageRoot)
    || !fs.lstatSync(packageRoot).isDirectory()
    || fs.lstatSync(packageRoot).isSymbolicLink()) {
    throw new FrameworkContractError('contract_shape_invalid', 'Bundled Full runtime package root is missing or is not a real directory.', {
      package_id: input.manifest.package_id,
      package_root: packageRoot,
      failure_code: 'agent_package_bundled_package_root_missing',
    });
  }
  const payload = parseJsonText(input.catalogEntry.payloadManifestJson);
  if (!isRecord(payload)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Bundled Full runtime payload manifest must be a JSON object.', {
      package_id: input.manifest.package_id,
      payload_manifest_url: input.catalogEntry.payloadManifestUrl,
      failure_code: 'agent_package_payload_manifest_invalid',
    });
  }
  const admission = admitPackagePayloadManifest({
    payload,
    manifest: input.manifest,
    payloadManifestUrl: input.catalogEntry.payloadManifestUrl,
    catalogSelection: {
      package_id: input.catalogEntry.packageId,
      package_version: input.catalogEntry.packageVersion,
      owner_source_commit: input.catalogEntry.ownerSourceCommit,
    },
  });
  const sourceRoot = safeBundledSourceRoot(stringValue(payload.source_root) ?? '');
  const sourceRootPath = path.resolve(packageRoot, sourceRoot);
  if ((sourceRootPath !== packageRoot && !sourceRootPath.startsWith(`${packageRoot}${path.sep}`))
    || !fs.existsSync(sourceRootPath)
    || !fs.lstatSync(sourceRootPath).isDirectory()
    || fs.lstatSync(sourceRootPath).isSymbolicLink()) {
    throw new FrameworkContractError('contract_shape_invalid', 'Bundled Full runtime payload source root is missing or unsafe.', {
      package_id: input.manifest.package_id,
      package_root: packageRoot,
      source_root: sourceRoot,
      failure_code: 'agent_package_bundled_payload_source_root_invalid',
    });
  }
  assertBundledPathComponentsAreReal({
    rootPath: packageRoot,
    relativePath: sourceRoot,
    payloadManifestUrl: input.catalogEntry.payloadManifestUrl,
    payloadPath: sourceRoot,
  });
  const packageRootReal = fs.realpathSync(packageRoot);
  const sourceRootReal = fs.realpathSync(sourceRootPath);
  if (sourceRootReal !== packageRootReal && !sourceRootReal.startsWith(`${packageRootReal}${path.sep}`)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Bundled Full runtime payload source root escapes its packaged module root.', {
      package_id: input.manifest.package_id,
      package_root: packageRoot,
      package_root_real: packageRootReal,
      source_root: sourceRoot,
      source_root_real: sourceRootReal,
      failure_code: 'agent_package_bundled_payload_path_escape',
    });
  }
  const files = recordList(payload.files).map((entry, index) => bundledPayloadFile({
    packageRoot,
    sourceRoot,
    entry,
    payloadManifestUrl: input.catalogEntry.payloadManifestUrl,
    index,
    admission,
  }));
  if (!Array.isArray(payload.files) || files.length !== payload.files.length) {
    throw new FrameworkContractError('contract_shape_invalid', 'Bundled Full runtime payload files must all be JSON objects.', {
      package_id: input.manifest.package_id,
      payload_manifest_url: input.catalogEntry.payloadManifestUrl,
      failure_code: 'agent_package_payload_manifest_invalid',
    });
  }
  verifyCanonicalPayloadContentLock(admission, files, input.catalogEntry.payloadManifestUrl);
  return {
    ...input.manifest,
    plugin_source_path: sourceRootPath,
    plugin_payload_manifest_url: input.catalogEntry.payloadManifestUrl,
    plugin_payload_manifest_sha256: input.catalogEntry.payloadManifestSha256.replace(/^sha256:/, ''),
    plugin_payload_cache_path: null,
    verified_payload_source_commit: admission.sourceCommit,
  };
}
