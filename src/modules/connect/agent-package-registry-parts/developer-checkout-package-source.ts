import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import workflowProfilePayloadAllowlistSchema from '../../../../contracts/opl-framework/package-payload-allowlist.schema.json' with { type: 'json' };
import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import { stringValue } from '../../../kernel/json-record.ts';
import { assertJsonSchemaPayload } from '../../../kernel/schema-registry.ts';
import { getOplPackageSpecs } from '../package-distribution.ts';
import { readDeveloperCheckoutSourceIdentity } from './developer-checkout-runtime-source.ts';
import { normalizePackageManifest } from './manifest-normalizers.ts';
import {
  CANONICAL_PACKAGE_CONTENT_LOCK,
  modeAwarePackageContentLockDigest,
} from './payload-content-lock.ts';
import type {
  AgentPackageDeveloperCheckoutSource,
  AgentPackageManifest,
} from './types.ts';

const IGNORED_SOURCE_NAMES = new Set([
  '.DS_Store',
  '.codegraph',
  '.git',
  '.pytest_cache',
  '.venv',
  '__pycache__',
  'node_modules',
]);

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const WORKFLOW_PROFILE_PAYLOAD_ALLOWLIST_SCHEMA_REF =
  'contracts/opl-framework/package-payload-allowlist.schema.json';

function sha256(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export type DeveloperCheckoutPayloadFile = {
  path: string;
  content: Buffer;
  mode: '100644' | '100755';
};

export function developerCheckoutPayloadDigest(files: DeveloperCheckoutPayloadFile[]) {
  return modeAwarePackageContentLockDigest(files);
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sourceFailure(message: string, details: Record<string, unknown>) {
  return new FrameworkContractError('contract_shape_invalid', message, {
    ...details,
    failure_code: 'agent_package_developer_checkout_source_invalid',
  });
}

function isSafePathSegment(value: string) {
  return value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && path.basename(value) === value;
}

function frameworkPackageManifest(spec: ReturnType<typeof getOplPackageSpecs>[number]) {
  const manifestPath = path.resolve(frameworkRoot, spec.package_manifest_ref);
  if (!isInside(frameworkRoot, manifestPath)
    || !fs.existsSync(manifestPath)
    || !fs.statSync(manifestPath).isFile()) {
    throw sourceFailure('Framework package manifest for developer checkout reconciliation is unavailable.', {
      package_id: spec.package_id,
      framework_manifest_path: manifestPath,
    });
  }
  const payload = parseJsonText(fs.readFileSync(manifestPath, 'utf8'));
  if (!isRecord(payload)) {
    throw sourceFailure('Framework package manifest for developer checkout reconciliation is invalid.', {
      package_id: spec.package_id,
      framework_manifest_path: manifestPath,
    });
  }
  return payload;
}

function normalizeDeveloperOwnerManifest(input: {
  spec: ReturnType<typeof getOplPackageSpecs>[number];
  payload: unknown;
  manifestPath: string;
}) {
  const base = frameworkPackageManifest(input.spec);
  if (input.spec.owner_manifest_kind === 'workflow_profile') {
    const policy = isRecord(input.payload) ? input.payload : null;
    const policyPackage = policy && isRecord(policy.package) ? policy.package : null;
    if (![
      'opl_flow_workflow_policy.v1',
      'opl_flow_workflow_policy.v2',
      'opl_flow_workflow_policy.v3',
      'opl_flow_workflow_policy.v4',
    ].includes(String(policy?.schema))
      || policyPackage?.id !== input.spec.package_id
      || policyPackage.kind !== 'workflow_profile'
      || !stringValue(policyPackage.version)) {
      throw sourceFailure('Developer workflow profile checkout has an invalid owner policy identity.', {
        package_id: input.spec.package_id,
        owner_manifest_path: input.manifestPath,
      });
    }
    return normalizePackageManifest({
      ...base,
      version: stringValue(policyPackage.version),
    }, input.manifestPath);
  }

  if (input.spec.owner_manifest_kind === 'standard_agent') {
    if (!isRecord(input.payload)
      || input.payload.surface_kind !== 'opl_agent_package_manifest.v1'
      || input.payload.package_id !== input.spec.package_id
      || input.payload.agent_id !== input.spec.package_id) {
      throw sourceFailure('Developer standard Agent checkout has an invalid owner manifest identity.', {
        package_id: input.spec.package_id,
        owner_manifest_path: input.manifestPath,
      });
    }
    const baseCodexSurface = isRecord(base.codex_surface) ? base.codex_surface : {};
    const ownerCodexSurface = isRecord(input.payload.codex_surface) ? input.payload.codex_surface : {};
    return normalizePackageManifest({
      ...base,
      ...input.payload,
      codex_surface: {
        ...baseCodexSurface,
        ...ownerCodexSurface,
      },
    }, input.manifestPath);
  }

  if (isRecord(input.payload)
    && input.payload.surface_kind === 'opl_capability_package_manifest.v2'
    && !isRecord(input.payload.content_lock)) {
    const exports = isRecord(input.payload.exports) ? input.payload.exports : {};
    const contentLockPaths = [
      ...(Array.isArray(exports.core_skill_ids) ? exports.core_skill_ids : []),
      ...(Array.isArray(exports.specialty_skill_ids) ? exports.specialty_skill_ids : []),
    ]
      .filter((skillId): skillId is string => typeof skillId === 'string' && skillId.length > 0)
      .map((skillId) => `skills/${skillId}/SKILL.md`);
    const normalized = normalizePackageManifest({
      ...input.payload,
      content_lock: {
        algorithm: 'sha256',
        canonicalization: CANONICAL_PACKAGE_CONTENT_LOCK,
        digest: `sha256:${'0'.repeat(64)}`,
        paths: contentLockPaths,
      },
    }, input.manifestPath);
    return {
      ...normalized,
      content_digest: null,
      content_lock_canonicalization: null,
      content_lock_paths: [],
    };
  }

  return normalizePackageManifest(input.payload, input.manifestPath);
}

function declaredPackageSurfacePaths(manifest: AgentPackageManifest) {
  return [...new Set([
    ...manifest.content_lock_paths,
    ...(manifest.profile_surface
      ? [
          manifest.profile_surface.runtime_profile.source_path,
          ...manifest.profile_surface.authoring_sources.map((entry) => entry.source_path),
          ...manifest.profile_surface.merge_context_paths,
        ]
      : []),
    ...(manifest.managed_policy_surface
      ? [
          manifest.managed_policy_surface.source_path,
          manifest.managed_policy_surface.schema_path,
        ]
      : []),
  ])];
}

function collectFiles(root: string, candidate: string, files: Map<string, DeveloperCheckoutPayloadFile>) {
  if (!isInside(root, candidate) || !fs.existsSync(candidate)) {
    throw sourceFailure('Developer checkout package source path is missing or escapes its plugin root.', {
      plugin_source_path: root,
      source_path: candidate,
    });
  }
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) {
    throw sourceFailure('Developer checkout package source does not admit symbolic links.', {
      plugin_source_path: root,
      source_path: candidate,
    });
  }
  if (stat.isFile()) {
    if (candidate.endsWith('.pyc')) return;
    const relativePath = path.relative(root, candidate).split(path.sep).join('/');
    files.set(relativePath, {
      path: relativePath,
      content: fs.readFileSync(candidate),
      mode: stat.mode & 0o111 ? '100755' : '100644',
    });
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
    if (IGNORED_SOURCE_NAMES.has(entry.name)) continue;
    collectFiles(root, path.join(candidate, entry.name), files);
  }
}

function assertPortablePayloadPaths(packageId: string, paths: string[]) {
  const seen = new Map<string, string>();
  for (const candidate of paths) {
    const segments = candidate.split('/');
    if (path.posix.isAbsolute(candidate)
      || candidate.includes('\\')
      || /[\u0000-\u001f\u007f]/.test(candidate)
      || segments.some((segment) => !segment || segment === '.' || segment === '..')
      || path.posix.normalize(candidate) !== candidate
      || candidate.normalize('NFC') !== candidate) {
      throw sourceFailure('Workflow profile payload allowlist contains an unsafe path.', {
        package_id: packageId,
        payload_path: candidate,
      });
    }
    const collisionKey = candidate.normalize('NFKC').toLowerCase();
    const previous = seen.get(collisionKey);
    if (previous !== undefined) {
      throw sourceFailure('Workflow profile payload allowlist contains a portable path collision.', {
        package_id: packageId,
        first_path: previous,
        second_path: candidate,
      });
    }
    seen.set(collisionKey, candidate);
  }
}

function collectAllowlistedFile(
  root: string,
  relativePath: string,
  files: Map<string, DeveloperCheckoutPayloadFile>,
) {
  const candidate = path.resolve(root, ...relativePath.split('/'));
  if (!isInside(root, candidate) || !fs.existsSync(candidate)) {
    throw sourceFailure('Workflow profile developer checkout is missing an allowlisted payload file.', {
      plugin_source_path: root,
      payload_path: relativePath,
    });
  }
  const realCandidate = fs.realpathSync(candidate);
  if (realCandidate !== candidate || !isInside(root, realCandidate)) {
    throw sourceFailure('Workflow profile payload allowlist does not admit symbolic-link traversal.', {
      plugin_source_path: root,
      payload_path: relativePath,
      resolved_path: realCandidate,
    });
  }
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw sourceFailure('Workflow profile payload allowlist only admits regular files.', {
        plugin_source_path: root,
        payload_path: relativePath,
      });
    }
    files.set(relativePath, {
      path: relativePath,
      content: fs.readFileSync(descriptor),
      mode: stat.mode & 0o111 ? '100755' : '100644',
    });
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function workflowProfilePayloadPaths(input: {
  spec: ReturnType<typeof getOplPackageSpecs>[number];
  checkoutRoot: string;
  pluginRoot: string;
  pluginId: string;
  ownerManifest: AgentPackageManifest;
  ownerManifestPath: string;
  pluginManifestPath: string;
}) {
  const allowlistPath = path.resolve(
    frameworkRoot,
    'contracts',
    'opl-framework',
    'package-payload-allowlists',
    `${input.spec.package_id}.json`,
  );
  if (!isInside(frameworkRoot, allowlistPath)
    || !fs.existsSync(allowlistPath)
    || !fs.lstatSync(allowlistPath).isFile()
    || fs.lstatSync(allowlistPath).isSymbolicLink()) {
    throw sourceFailure('Framework workflow profile payload allowlist is unavailable.', {
      package_id: input.spec.package_id,
      allowlist_path: allowlistPath,
    });
  }
  const allowlist = parseJsonText(fs.readFileSync(allowlistPath, 'utf8'));
  try {
    assertJsonSchemaPayload({
      schemaId: workflowProfilePayloadAllowlistSchema.$id,
      schema: workflowProfilePayloadAllowlistSchema,
      sourceRef: WORKFLOW_PROFILE_PAYLOAD_ALLOWLIST_SCHEMA_REF,
    }, allowlist);
  } catch (error) {
    if (!(error instanceof FrameworkContractError)) throw error;
    throw sourceFailure('Framework workflow profile payload allowlist is invalid.', {
      package_id: input.spec.package_id,
      allowlist_path: allowlistPath,
      schema_errors: error.details?.errors ?? [],
    });
  }
  if (!isRecord(allowlist)) {
    throw sourceFailure('Framework workflow profile payload allowlist is invalid.', {
      package_id: input.spec.package_id,
      allowlist_path: allowlistPath,
    });
  }
  const paths = allowlist.paths as string[];
  assertPortablePayloadPaths(input.spec.package_id, paths);
  if (allowlist.package_id !== input.spec.package_id
    || allowlist.plugin_id !== input.pluginId
    || allowlist.source_repo !== input.spec.repo_url
    || (input.ownerManifest.source_repo !== null
      && allowlist.source_repo !== input.ownerManifest.source_repo)) {
    throw sourceFailure('Workflow profile payload allowlist identity does not match its Package.', {
      package_id: input.spec.package_id,
      plugin_id: input.pluginId,
      allowlist_path: allowlistPath,
    });
  }
  const sourceRootCandidate = path.resolve(input.checkoutRoot, String(allowlist.source_root));
  if (!isInside(input.checkoutRoot, sourceRootCandidate)
    || !fs.existsSync(sourceRootCandidate)
    || !fs.lstatSync(sourceRootCandidate).isDirectory()
    || fs.lstatSync(sourceRootCandidate).isSymbolicLink()
    || fs.realpathSync(sourceRootCandidate) !== input.pluginRoot) {
    throw sourceFailure('Workflow profile payload allowlist source root does not match its plugin root.', {
      package_id: input.spec.package_id,
      checkout_path: input.checkoutRoot,
      plugin_source_path: input.pluginRoot,
      allowlist_source_root: allowlist.source_root,
    });
  }
  const requiredPaths = [
    path.relative(input.pluginRoot, input.pluginManifestPath).split(path.sep).join('/'),
    path.relative(input.pluginRoot, input.ownerManifestPath).split(path.sep).join('/'),
    'opl-package.json',
    ...input.ownerManifest.required_skill_ids.map((skillId) => `skills/${skillId}/SKILL.md`),
    ...declaredPackageSurfacePaths(input.ownerManifest),
  ];
  const missingRequiredPaths = [...new Set(requiredPaths)].filter((candidate) => !paths.includes(candidate));
  if (missingRequiredPaths.length > 0) {
    throw sourceFailure('Workflow profile payload allowlist omits a required Package surface.', {
      package_id: input.spec.package_id,
      allowlist_path: allowlistPath,
      missing_paths: missingRequiredPaths,
    });
  }
  return paths;
}

function fallbackDeveloperIdentity(checkoutPath: string) {
  const hash = crypto.createHash('sha256');
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      if (IGNORED_SOURCE_NAMES.has(entry.name)) continue;
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(checkoutPath, absolutePath).split(path.sep).join('/');
      const stat = fs.lstatSync(absolutePath);
      const mode = (stat.mode & 0o777).toString(8);
      if (stat.isDirectory()) {
        hash.update(`dir\0${relativePath}\0${mode}\0`);
        visit(absolutePath);
      } else if (stat.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0${mode}\0${fs.readlinkSync(absolutePath)}\0`);
      } else if (stat.isFile()) {
        hash.update(`file\0${relativePath}\0${mode}\0`);
        hash.update(fs.readFileSync(absolutePath));
        hash.update('\0');
      } else {
        hash.update(`special\0${relativePath}\0${mode}\0`);
      }
    }
  };
  visit(checkoutPath);
  return { source_git_head_sha: null, tree_sha256: hash.digest('hex') };
}

function captureIdentity(checkoutPath: string) {
  try {
    return readDeveloperCheckoutSourceIdentity(checkoutPath);
  } catch {
    return fallbackDeveloperIdentity(checkoutPath);
  }
}

function sameIdentity(
  left: ReturnType<typeof captureIdentity>,
  right: ReturnType<typeof captureIdentity>,
) {
  return left.source_git_head_sha === right.source_git_head_sha
    && left.tree_sha256 === right.tree_sha256;
}

function sameStringSet(left: string[], right: string[]) {
  return left.length === right.length
    && left.every((value) => right.includes(value));
}

function configuredCarrierDescriptorMatches(
  left: NonNullable<AgentPackageManifest['configured_codex_plugin_carrier']>,
  right: NonNullable<AgentPackageManifest['configured_codex_plugin_carrier']>,
) {
  return left.packageId === right.packageId
    && left.carrier.kind === right.carrier.kind
    && left.carrier.pluginId === right.carrier.pluginId
    && left.executor.route === right.executor.route
    && sameStringSet(left.executor.requiredSkillIds, right.executor.requiredSkillIds);
}

function payloadFile(sourcePath: string): DeveloperCheckoutPayloadFile {
  const stat = fs.lstatSync(sourcePath);
  return {
    path: 'opl-package.json',
    content: fs.readFileSync(sourcePath),
    mode: stat.mode & 0o111 ? '100755' : '100644',
  };
}

function normalizeConfiguredCarrierOwnerDescriptor(input: {
  spec: ReturnType<typeof getOplPackageSpecs>[number];
  payload: unknown;
  manifestPath: string;
}) {
  return isRecord(input.payload)
    && input.payload.surface_kind === 'opl_capability_package_manifest.v2'
    && !isRecord(input.payload.content_lock)
    ? normalizeDeveloperOwnerManifest(input)
    : normalizePackageManifest(input.payload, input.manifestPath);
}

function configuredCarrierDescriptorMismatches(
  descriptor: AgentPackageManifest,
  owner: AgentPackageManifest,
) {
  const descriptorCarrier = descriptor.configured_codex_plugin_carrier;
  const ownerCarrier = owner.configured_codex_plugin_carrier!;
  return [
    descriptor.package_id === owner.package_id ? null : 'package_id',
    descriptor.agent_id === owner.agent_id ? null : 'agent_id',
    descriptor.version === owner.version ? null : 'version',
    descriptor.plugin_id === owner.plugin_id ? null : 'plugin_id',
    sameStringSet(descriptor.required_skill_ids, owner.required_skill_ids)
      ? null
      : 'required_skill_ids',
    descriptorCarrier && configuredCarrierDescriptorMatches(descriptorCarrier, ownerCarrier)
      ? null
      : 'configured_codex_plugin_carrier',
  ].filter((field): field is string => field !== null);
}

function validatedConfiguredCarrierDescriptor(input: {
  spec: ReturnType<typeof getOplPackageSpecs>[number];
  ownerManifest: AgentPackageManifest;
  pluginRoot: string;
  descriptorCandidate: string;
}) {
  const descriptorStat = fs.lstatSync(input.descriptorCandidate);
  if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink()) {
    throw sourceFailure('Configured carrier developer checkout owner descriptor must be a regular file.', {
      package_id: input.ownerManifest.package_id,
      plugin_source_path: input.pluginRoot,
      owner_descriptor_path: input.descriptorCandidate,
    });
  }
  const descriptorPath = fs.realpathSync(input.descriptorCandidate);
  if (!isInside(input.pluginRoot, descriptorPath)) {
    throw sourceFailure('Configured carrier developer checkout owner descriptor escapes its plugin root.', {
      package_id: input.ownerManifest.package_id,
      plugin_source_path: input.pluginRoot,
      owner_descriptor_path: descriptorPath,
    });
  }
  let descriptorManifest: AgentPackageManifest;
  try {
    descriptorManifest = normalizeConfiguredCarrierOwnerDescriptor({
      spec: input.spec,
      payload: parseJsonText(fs.readFileSync(descriptorPath, 'utf8')),
      manifestPath: descriptorPath,
    });
  } catch (error) {
    throw sourceFailure('Configured carrier developer checkout owner descriptor is invalid.', {
      package_id: input.ownerManifest.package_id,
      owner_descriptor_path: descriptorPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const mismatchedFields = configuredCarrierDescriptorMismatches(
    descriptorManifest,
    input.ownerManifest,
  );
  if (mismatchedFields.length > 0) {
    throw sourceFailure('Configured carrier developer checkout owner descriptor does not match its owner manifest.', {
      package_id: input.ownerManifest.package_id,
      owner_descriptor_path: descriptorPath,
      mismatched_fields: mismatchedFields,
    });
  }
  return payloadFile(descriptorPath);
}

function collectConfiguredCarrierOwnerDescriptor(input: {
  spec: ReturnType<typeof getOplPackageSpecs>[number];
  ownerManifest: AgentPackageManifest;
  ownerManifestPath: string;
  pluginRoot: string;
  files: Map<string, DeveloperCheckoutPayloadFile>;
}) {
  if (!input.ownerManifest.configured_codex_plugin_carrier) return;
  const descriptorCandidate = path.join(input.pluginRoot, 'opl-package.json');
  const descriptor = fs.existsSync(descriptorCandidate)
    ? validatedConfiguredCarrierDescriptor({ ...input, descriptorCandidate })
    : payloadFile(input.ownerManifestPath);
  input.files.set(descriptor.path, descriptor);
}

function validatedDeveloperPluginId(input: {
  packageId: string;
  ownerManifest: AgentPackageManifest;
  pluginManifestPath: string;
}) {
  const pluginManifest = parseJsonText(fs.readFileSync(input.pluginManifestPath, 'utf8'));
  const pluginId = isRecord(pluginManifest) ? stringValue(pluginManifest.name) : null;
  const pluginVersion = isRecord(pluginManifest) ? stringValue(pluginManifest.version) : null;
  if (!pluginId
    || !isSafePathSegment(pluginId)
    || pluginVersion !== input.ownerManifest.version
    || (input.ownerManifest.plugin_id !== null && !isSafePathSegment(input.ownerManifest.plugin_id))
    || (input.ownerManifest.plugin_id && input.ownerManifest.plugin_id !== pluginId)) {
    throw sourceFailure('Developer checkout plugin manifest identity does not match its owner manifest.', {
      package_id: input.packageId,
      owner_plugin_id: input.ownerManifest.plugin_id,
      plugin_manifest_id: pluginId,
      owner_version: input.ownerManifest.version,
      plugin_manifest_version: pluginVersion,
      plugin_manifest_path: input.pluginManifestPath,
    });
  }
  return pluginId;
}

function assertConfiguredCarrierOwnerDescriptor(input: {
  spec: ReturnType<typeof getOplPackageSpecs>[number];
  ownerManifest: AgentPackageManifest;
  pluginRoot: string;
}) {
  if (!input.ownerManifest.configured_codex_plugin_carrier) return;
  const ownerDescriptorPath = path.join(input.pluginRoot, 'opl-package.json');
  if (!fs.existsSync(ownerDescriptorPath)) {
    throw sourceFailure('Configured carrier developer checkout is missing its owner descriptor.', {
      package_id: input.ownerManifest.package_id,
      owner_descriptor_path: ownerDescriptorPath,
    });
  }
  validatedConfiguredCarrierDescriptor({
    ...input,
    descriptorCandidate: ownerDescriptorPath,
  });
}

export function loadDeveloperCheckoutPackageSource(packageId: string, checkoutPath: string) {
  const spec = getOplPackageSpecs().find((entry) => entry.package_id === packageId);
  const resolvedCheckout = path.resolve(checkoutPath);
  if (!spec || !fs.existsSync(resolvedCheckout) || !fs.statSync(resolvedCheckout).isDirectory()) {
    throw sourceFailure('Developer checkout package source is unavailable.', {
      package_id: packageId,
      checkout_path: resolvedCheckout,
    });
  }
  const checkoutReal = fs.realpathSync(resolvedCheckout);
  const identityBefore = captureIdentity(checkoutReal);
  const ownerManifestCandidate = path.resolve(checkoutReal, spec.owner_package_manifest_ref);
  const pluginManifestCandidate = path.resolve(checkoutReal, spec.owner_plugin_manifest_ref);
  if (!isInside(checkoutReal, ownerManifestCandidate)
    || !isInside(checkoutReal, pluginManifestCandidate)
    || !fs.existsSync(ownerManifestCandidate)
    || !fs.lstatSync(ownerManifestCandidate).isFile()
    || fs.lstatSync(ownerManifestCandidate).isSymbolicLink()
    || !fs.existsSync(pluginManifestCandidate)
    || !fs.lstatSync(pluginManifestCandidate).isFile()
    || fs.lstatSync(pluginManifestCandidate).isSymbolicLink()) {
    throw sourceFailure('Developer checkout is missing its owner or plugin manifest.', {
      package_id: packageId,
      checkout_path: checkoutReal,
      owner_manifest_path: ownerManifestCandidate,
      plugin_manifest_path: pluginManifestCandidate,
    });
  }
  const ownerManifestPath = fs.realpathSync(ownerManifestCandidate);
  const pluginManifestPath = fs.realpathSync(pluginManifestCandidate);
  if (!isInside(checkoutReal, ownerManifestPath) || !isInside(checkoutReal, pluginManifestPath)) {
    throw sourceFailure('Developer checkout manifests escape the checkout through an intermediate path.', {
      package_id: packageId,
      checkout_path: checkoutReal,
      owner_manifest_path: ownerManifestPath,
      plugin_manifest_path: pluginManifestPath,
    });
  }

  const ownerManifestBytes = fs.readFileSync(ownerManifestPath);
  const ownerManifestSha256 = sha256(ownerManifestBytes);
  const ownerManifest = normalizeDeveloperOwnerManifest({
    spec,
    payload: parseJsonText(ownerManifestBytes.toString('utf8')),
    manifestPath: ownerManifestPath,
  });
  if (ownerManifest.package_id !== packageId) {
    throw sourceFailure('Developer checkout owner manifest does not match the requested package.', {
      package_id: packageId,
      owner_manifest_package_id: ownerManifest.package_id,
      owner_manifest_path: ownerManifestPath,
    });
  }
  const pluginId = validatedDeveloperPluginId({ packageId, ownerManifest, pluginManifestPath });

  const pluginRoot = fs.realpathSync(path.dirname(path.dirname(pluginManifestPath)));
  if (!isInside(checkoutReal, pluginRoot)) {
    throw sourceFailure('Developer checkout plugin source escapes its checkout.', {
      package_id: packageId,
      checkout_path: checkoutReal,
      plugin_source_path: pluginRoot,
    });
  }
  assertConfiguredCarrierOwnerDescriptor({ spec, ownerManifest, pluginRoot });
  const files = new Map<string, DeveloperCheckoutPayloadFile>();
  if (spec.owner_manifest_kind === 'workflow_profile') {
    for (const relativePath of workflowProfilePayloadPaths({
      spec,
      checkoutRoot: checkoutReal,
      pluginRoot,
      pluginId,
      ownerManifest,
      ownerManifestPath,
      pluginManifestPath,
    })) {
      collectAllowlistedFile(pluginRoot, relativePath, files);
    }
  } else {
    collectConfiguredCarrierOwnerDescriptor({
      spec,
      ownerManifest,
      ownerManifestPath,
      pluginRoot,
      files,
    });
    collectFiles(pluginRoot, pluginManifestPath, files);
    for (const skillId of ownerManifest.required_skill_ids) {
      collectFiles(pluginRoot, path.join(pluginRoot, 'skills', skillId), files);
    }
    for (const relativePath of declaredPackageSurfacePaths(ownerManifest)) {
      const sourcePath = path.resolve(checkoutReal, relativePath);
      if (!isInside(pluginRoot, sourcePath)) {
        throw sourceFailure('Developer checkout declared package surface escapes its plugin root.', {
          package_id: packageId,
          plugin_source_path: pluginRoot,
          declared_source_path: sourcePath,
        });
      }
      collectFiles(pluginRoot, sourcePath, files);
    }
    if (isInside(pluginRoot, ownerManifestPath)) collectFiles(pluginRoot, ownerManifestPath, files);
  }
  const copyPaths = [...files.keys()].sort();
  const payloadFiles = copyPaths.map((relativePath) => {
    const file = files.get(relativePath)!;
    return { ...file, content: Buffer.from(file.content) };
  });
  const payloadDigest = developerCheckoutPayloadDigest(payloadFiles);
  const identityAfter = captureIdentity(checkoutReal);
  if (!sameIdentity(identityBefore, identityAfter)) {
    throw sourceFailure('Developer checkout changed while its package snapshot was being captured.', {
      package_id: packageId,
      checkout_path: checkoutReal,
      before_source_git_head_sha: identityBefore.source_git_head_sha,
      after_source_git_head_sha: identityAfter.source_git_head_sha,
      before_tree_sha256: identityBefore.tree_sha256,
      after_tree_sha256: identityAfter.tree_sha256,
    });
  }
  const source: AgentPackageDeveloperCheckoutSource = {
    surface_kind: 'opl_agent_package_developer_checkout_source.v1',
    checkout_path: checkoutReal,
    owner_manifest_path: ownerManifestPath,
    owner_manifest_sha256: ownerManifestSha256,
    plugin_source_path: pluginRoot,
    source_git_head_sha: identityAfter.source_git_head_sha,
    tree_sha256: identityAfter.tree_sha256,
    payload_digest: payloadDigest,
    declared_content_digest: ownerManifest.content_digest,
    copy_paths: copyPaths,
    copy_file_modes: Object.fromEntries(payloadFiles.map((file) => [file.path, file.mode])),
  };
  return {
    ownerManifest,
    source,
    pluginId,
    payloadFiles,
  };
}

function readDeveloperMarketplace(input: {
  packageId: string;
  checkoutPath: string;
  manifestPath: string;
}) {
  let marketplace: unknown;
  try {
    const stat = fs.lstatSync(input.manifestPath);
    const realPath = fs.realpathSync(input.manifestPath);
    if (!stat.isFile()
      || stat.isSymbolicLink()
      || !isInside(input.checkoutPath, realPath)) {
      throw new Error('marketplace manifest is not a real checkout file');
    }
    marketplace = parseJsonText(fs.readFileSync(realPath, 'utf8'));
  } catch (error) {
    throw sourceFailure('Developer checkout local marketplace manifest is missing, unsafe, or invalid.', {
      package_id: input.packageId,
      marketplace_manifest_path: input.manifestPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return marketplace;
}

function matchingDeveloperMarketplacePlugins(marketplace: unknown, pluginId: string) {
  if (!isRecord(marketplace) || !Array.isArray(marketplace.plugins)) return [];
  return marketplace.plugins.flatMap((value) => {
    const entry = isRecord(value) ? value : null;
    return entry && stringValue(entry.name) === pluginId ? [entry] : [];
  });
}

function developerMarketplaceIdentityMatches(input: {
  marketplace: unknown;
  marketplaceId: string;
  matchingPluginCount: number;
  declaredSource: Record<string, unknown> | null;
}) {
  if (!isRecord(input.marketplace)) return false;
  if (stringValue(input.marketplace.name) !== input.marketplaceId) return false;
  if (input.matchingPluginCount !== 1) return false;
  return stringValue(input.declaredSource?.source) === 'local';
}

function developerMarketplacePathMatches(input: {
  checkoutPath: string;
  declaredPluginPath: string | null;
  verifiedPluginSourcePath: string;
}) {
  if (!input.declaredPluginPath || !isInside(input.checkoutPath, input.declaredPluginPath)) {
    return false;
  }
  if (!fs.existsSync(input.declaredPluginPath)) return false;
  const stat = fs.lstatSync(input.declaredPluginPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  return fs.realpathSync(input.declaredPluginPath) === input.verifiedPluginSourcePath;
}

function verifiedDeveloperMarketplacePluginPath(input: {
  source: ReturnType<typeof loadDeveloperCheckoutPackageSource>;
  marketplace: unknown;
  marketplaceManifestPath: string;
  pluginId: string;
  marketplaceId: string;
}) {
  const matchingPlugins = matchingDeveloperMarketplacePlugins(input.marketplace, input.pluginId);
  const declaredSource = matchingPlugins.length === 1 && isRecord(matchingPlugins[0].source)
    ? matchingPlugins[0].source
    : null;
  const declaredPath = stringValue(declaredSource?.path);
  const declaredPluginPath = declaredPath && !path.isAbsolute(declaredPath)
    ? path.resolve(input.source.source.checkout_path, declaredPath)
    : null;
  const marketplaceMatches = developerMarketplaceIdentityMatches({
    marketplace: input.marketplace,
    marketplaceId: input.marketplaceId,
    matchingPluginCount: matchingPlugins.length,
    declaredSource,
  });
  const pathMatches = developerMarketplacePathMatches({
    checkoutPath: input.source.source.checkout_path,
    declaredPluginPath,
    verifiedPluginSourcePath: input.source.source.plugin_source_path,
  });
  if (!marketplaceMatches || !pathMatches) {
    throw sourceFailure('Developer checkout local marketplace does not match its verified plugin source.', {
      package_id: input.source.ownerManifest.package_id,
      plugin_selector: input.source.ownerManifest.configured_codex_plugin_carrier?.carrier.pluginId,
      marketplace_id: isRecord(input.marketplace) ? stringValue(input.marketplace.name) : null,
      marketplace_manifest_path: input.marketplaceManifestPath,
      matching_plugin_count: matchingPlugins.length,
      declared_plugin_path: declaredPluginPath,
      verified_plugin_source_path: input.source.source.plugin_source_path,
    });
  }
  return declaredPluginPath;
}

export function developerCheckoutConfiguredCarrierTarget(
  source: ReturnType<typeof loadDeveloperCheckoutPackageSource>,
) {
  const descriptor = source.ownerManifest.configured_codex_plugin_carrier;
  if (!descriptor) {
    throw sourceFailure('Developer checkout owner manifest has no configured native carrier.', {
      package_id: source.ownerManifest.package_id,
      checkout_path: source.source.checkout_path,
    });
  }
  const separator = descriptor.carrier.pluginId.lastIndexOf('@');
  const pluginId = descriptor.carrier.pluginId.slice(0, separator);
  const marketplaceId = descriptor.carrier.pluginId.slice(separator + 1);
  const marketplaceManifestPath = path.join(
    source.source.checkout_path, '.agents', 'plugins', 'marketplace.json');
  const marketplace = readDeveloperMarketplace({
    packageId: source.ownerManifest.package_id,
    checkoutPath: source.source.checkout_path,
    manifestPath: marketplaceManifestPath,
  });
  verifiedDeveloperMarketplacePluginPath({
    source, marketplace, marketplaceManifestPath, pluginId, marketplaceId,
  });
  return {
    descriptor: {
      ...descriptor,
      carrier: {
        ...descriptor.carrier,
        marketplaceSource: source.source.checkout_path,
      },
      publicationRef: null,
    },
    packageVersion: source.ownerManifest.version,
    developerSource: source,
  };
}
