import fs from 'node:fs';
import path from 'node:path';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import { stringValue } from '../../../kernel/json-record.ts';
import { resolveFirstPartyPackageCatalog } from '../agent-package-first-party.ts';
import { readOplPackageArtifactWithMetadata } from '../system-installation/module-package-channel.ts';
import {
  selectManagedCatalogPackageVersion,
  type ManagedPackageCatalog,
} from './capability-reconciliation.ts';
import { normalizePackageManifest } from './manifest-normalizers.ts';
import {
  CANONICAL_PACKAGE_CONTENT_LOCK,
  LEGACY_PACKAGE_CONTENT_LOCK,
  packageContentLockDigest,
  type PackageContentLockCanonicalization,
} from './payload-content-lock.ts';
import { assertSafePersistedPackagePath } from './persisted-path-safety.ts';
import { resolveCodexHome } from './shared.ts';
import type { AgentPackageLock, AgentPackageLockIndex } from './types.ts';

function normalizedSha256Digest(value: string | null | undefined) {
  if (!value) return null;
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function exactPackageArtifactRef(sourceArtifactRef: string, artifactDigest: string) {
  const lastSlash = sourceArtifactRef.lastIndexOf('/');
  const digestSeparator = sourceArtifactRef.lastIndexOf('@');
  const tagSeparator = sourceArtifactRef.lastIndexOf(':');
  const repository = digestSeparator > lastSlash
    ? sourceArtifactRef.slice(0, digestSeparator)
    : tagSeparator > lastSlash
      ? sourceArtifactRef.slice(0, tagSeparator)
      : sourceArtifactRef;
  return `${repository}@${artifactDigest}`;
}

export function installedPackageLockClosure(index: AgentPackageLockIndex, root: AgentPackageLock) {
  const byId = new Map(index.packages.map((entry) => [entry.package_id, entry]));
  const visited = new Set<string>();
  const ordered: AgentPackageLock[] = [];
  const visit = (lock: AgentPackageLock) => {
    if (visited.has(lock.package_id)) return;
    visited.add(lock.package_id);
    for (const dependency of lock.resolved_dependencies ?? []) {
      const provider = byId.get(dependency.package_id);
      if (provider) visit(provider);
    }
    ordered.push(structuredClone(lock));
  };
  visit(root);
  return ordered;
}

function installedImmutableLockIdentity(lock: AgentPackageLock) {
  const sourceArtifactRef = stringValue(lock.source_artifact_ref);
  const artifactDigest = normalizedSha256Digest(lock.artifact_digest);
  const declaredPackageContentDigest = normalizedSha256Digest(lock.package_content_digest);
  const manifestSha256 = normalizedSha256Digest(lock.manifest_sha256);
  const ownerSourceCommit = stringValue(lock.owner_source_commit);
  const firstPartyOwner = resolveFirstPartyPackageCatalog(lock.package_id);
  const escapedPackageId = lock.package_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedPackageVersion = lock.package_version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const canonicalArtifactRef = new RegExp(
    `^ghcr\\.io/[^/]+/one-person-lab-packages/${escapedPackageId}:${escapedPackageVersion}$`,
  );
  if (!sourceArtifactRef
    || !artifactDigest
    || !/^sha256:[0-9a-f]{64}$/.test(artifactDigest)
    || !manifestSha256
    || !/^sha256:[0-9a-f]{64}$/.test(manifestSha256)
    || (declaredPackageContentDigest !== null
      && !/^sha256:[0-9a-f]{64}$/.test(declaredPackageContentDigest))
    || !/^sha256:[0-9a-f]{64}$/.test(normalizedSha256Digest(lock.content_digest) ?? '')
    || !ownerSourceCommit
    || !/^[0-9a-f]{40}$/.test(ownerSourceCommit)
    || !firstPartyOwner
    || lock.source_kind !== 'first_party_managed_cohort'
    || !canonicalArtifactRef.test(sourceArtifactRef)
    || lock.manifest_url !== `opl+oci://${sourceArtifactRef}#/package-manifest.json`) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Installed first-party Package lock is missing immutable repair identity.',
      {
        package_id: lock.package_id,
        package_version: lock.package_version,
        source_artifact_ref: sourceArtifactRef,
        artifact_digest: artifactDigest,
        package_content_digest: declaredPackageContentDigest,
        manifest_sha256: manifestSha256,
        owner_source_commit: ownerSourceCommit,
        source_kind: lock.source_kind,
        first_party_package: Boolean(firstPartyOwner),
        failure_code: 'agent_package_installed_immutable_identity_incomplete',
      },
    );
  }
  return {
    sourceArtifactRef,
    artifactDigest,
    declaredPackageContentDigest,
    manifestSha256,
    ownerSourceCommit,
  };
}

function readInstalledImmutableArtifact(
  lock: AgentPackageLock,
  identity: ReturnType<typeof installedImmutableLockIdentity>,
) {
  const exactArtifactRef = exactPackageArtifactRef(
    identity.sourceArtifactRef,
    identity.artifactDigest,
  );
  const artifact = readOplPackageArtifactWithMetadata(exactArtifactRef);
  const packageContentDigest = identity.declaredPackageContentDigest ?? artifact.source_layer_digest;
  const manifest = normalizePackageManifest(parseJsonText(artifact.manifest_json), lock.manifest_url);
  const payloadManifest = parseJsonText(artifact.payload_manifest_json);
  const payloadPackageSource = isRecord(payloadManifest)
    && isRecord(payloadManifest.package_source)
    ? payloadManifest.package_source
    : null;
  const artifactFailures = [
    artifact.descriptor_digest === identity.artifactDigest ? null : 'descriptor_digest_mismatch',
    identity.declaredPackageContentDigest === null
      || artifact.source_layer_digest === identity.declaredPackageContentDigest
      ? null
      : 'source_layer_digest_mismatch',
    artifact.manifest_layer_digest === identity.manifestSha256 ? null : 'manifest_layer_digest_mismatch',
    lock.physical_surface?.plugin_payload_manifest_sha256
      && normalizedSha256Digest(lock.physical_surface.plugin_payload_manifest_sha256)
        !== artifact.payload_layer_digest
      ? 'payload_layer_digest_mismatch'
      : null,
    manifest.package_id === lock.package_id ? null : 'manifest_package_id_mismatch',
    manifest.version === lock.package_version ? null : 'manifest_package_version_mismatch',
    (manifest.verified_payload_source_commit === identity.ownerSourceCommit
      || manifest.carrier_source_commit === identity.ownerSourceCommit)
      ? null
      : 'manifest_owner_source_commit_mismatch',
    isRecord(payloadManifest) && stringValue(payloadManifest.package_id) === lock.package_id
      ? null
      : 'payload_package_id_mismatch',
    isRecord(payloadManifest) && stringValue(payloadManifest.package_version) === lock.package_version
      ? null
      : 'payload_package_version_mismatch',
    isRecord(payloadManifest) && stringValue(payloadManifest.source_commit) === identity.ownerSourceCommit
      ? null
      : 'payload_owner_source_commit_mismatch',
    stringValue(payloadPackageSource?.artifact_ref) === identity.sourceArtifactRef
      ? null
      : 'payload_source_artifact_ref_mismatch',
  ].filter((failure): failure is string => failure !== null);
  if (artifactFailures.length > 0) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Installed first-party Package artifact does not match its immutable lock identity.',
      {
        package_id: lock.package_id,
        package_version: lock.package_version,
        source_artifact_ref: identity.sourceArtifactRef,
        exact_artifact_ref: exactArtifactRef,
        failures: artifactFailures,
        failure_code: 'agent_package_installed_immutable_identity_mismatch',
      },
    );
  }
  return { artifact, manifest, packageContentDigest };
}

function installedDependencyIdentityFailures(
  lock: AgentPackageLock,
  manifest: ReturnType<typeof normalizePackageManifest>,
  closureById: Map<string, AgentPackageLock>,
) {
  const declaredDependencies = new Map(
    manifest.capability_dependencies.map((entry) => [entry.package_id, entry]),
  );
  const resolvedDependencies = new Map(
    (lock.resolved_dependencies ?? []).map((entry) => [entry.package_id, entry]),
  );
  const failures = manifest.capability_dependencies.flatMap((dependency) =>
    dependency.required && !resolvedDependencies.has(dependency.package_id)
      ? [`${dependency.package_id}:required_resolution_missing`]
      : []);
  for (const dependency of lock.resolved_dependencies ?? []) {
    const declared = declaredDependencies.get(dependency.package_id);
    const provider = closureById.get(dependency.package_id);
    if (!declared) failures.push(`${dependency.package_id}:manifest_dependency_missing`);
    if (!provider) {
      failures.push(`${dependency.package_id}:installed_provider_missing`);
      continue;
    }
    if (dependency.required !== declared?.required
      || dependency.dependency_kind !== declared?.dependency_kind
      || dependency.version_requirement !== declared?.version_requirement
      || dependency.installed_version !== provider.package_version
      || normalizedSha256Digest(dependency.manifest_sha256)
        !== normalizedSha256Digest(provider.manifest_sha256)
      || dependency.source_artifact_ref !== provider.source_artifact_ref
      || normalizedSha256Digest(dependency.artifact_digest)
        !== normalizedSha256Digest(provider.artifact_digest)
      || dependency.owner_source_commit !== provider.owner_source_commit
      || dependency.content_digest !== provider.content_digest
      || dependency.package_lock_ref !== provider.lock_ref) {
      failures.push(`${dependency.package_id}:installed_resolution_identity_mismatch`);
    }
  }
  return failures;
}

export function installedImmutableRepairCatalog(
  index: AgentPackageLockIndex,
  rootLock: AgentPackageLock,
) {
  const catalog = new Map() as ManagedPackageCatalog;
  const closure = installedPackageLockClosure(index, rootLock);
  const closureById = new Map(closure.map((entry) => [entry.package_id, entry]));
  for (const lock of closure) {
    const identity = installedImmutableLockIdentity(lock);
    const { artifact, manifest, packageContentDigest } = readInstalledImmutableArtifact(lock, identity);
    const dependencyFailures = installedDependencyIdentityFailures(lock, manifest, closureById);
    if (dependencyFailures.length > 0) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Installed first-party Package dependency closure does not match its immutable locks.',
        {
          package_id: lock.package_id,
          dependency_failures: dependencyFailures,
          failure_code: 'agent_package_installed_dependency_identity_mismatch',
        },
      );
    }
    catalog.set(lock.package_id, {
      package_id: lock.package_id,
      package_role: lock.package_role
        ?? (lock.capability_provider ? 'capability_package' : 'standard_agent'),
      selected_version: lock.package_version,
      versions: [{
        package_version: lock.package_version,
        capability_abi: lock.capability_provider?.capability_abi ?? null,
        manifest_url: lock.manifest_url,
        manifest_sha256: identity.manifestSha256,
        manifest_json: artifact.manifest_json,
        payload_manifest_json: artifact.payload_manifest_json,
        payload_manifest_sha256: artifact.payload_layer_digest,
        content_digest: normalizedSha256Digest(lock.content_digest),
        payload_digest: artifact.payload_layer_digest,
        source_artifact_ref: identity.sourceArtifactRef,
        artifact_digest: identity.artifactDigest,
        artifact_status: 'published_immutable',
        package_content_digest: packageContentDigest,
        owner_source_commit: identity.ownerSourceCommit,
        dependency_package_ids: manifest.capability_dependencies.map((entry) => entry.package_id),
        selection_status: 'selected_for_release_set',
      }],
    });
  }
  const rootVersion = selectManagedCatalogPackageVersion(catalog, rootLock.package_id);
  const catalogSource = rootLock.managed_update_source;
  if (!catalogSource
    || catalogSource.kind !== 'managed_version_catalog'
    || catalogSource.digest_authority !== 'manifest_and_content_digest') {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Installed first-party Package lock is missing its managed catalog authority.',
      {
        package_id: rootLock.package_id,
        failure_code: 'agent_package_installed_catalog_authority_missing',
      },
    );
  }
  return {
    catalog,
    rootVersion,
    catalogSource,
    channelRef: rootLock.release_channel_ref ?? catalogSource.catalog_ref,
    channelDigest: rootLock.release_channel_digest ?? null,
  };
}

export function installedPackagePluginSourcePath(lock: AgentPackageLock) {
  return lock.physical_surface?.codex_plugin_cache_path
    ?? lock.physical_surface?.plugin_source_path
    ?? null;
}

function assertImmutableCacheRoot(lock: AgentPackageLock, cachePath: string) {
  const resolvedCachePath = assertSafePersistedPackagePath({
    candidatePath: cachePath,
    allowedRoots: [path.join(
      lock.physical_surface?.codex_home ?? resolveCodexHome(),
      'plugins',
      'cache',
    )],
    pathKind: 'lock.physical_surface.codex_plugin_cache_path',
  });
  const cacheStat = fs.existsSync(resolvedCachePath)
    ? fs.lstatSync(resolvedCachePath)
    : null;
  if (!cacheStat?.isDirectory() || cacheStat.isSymbolicLink()) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Installed package immutable plugin cache is missing or unsafe.',
      {
        package_id: lock.package_id,
        codex_plugin_cache_path: cachePath,
        failure_code: lock.source_kind === 'developer_checkout_override'
          ? 'agent_package_developer_checkout_lkg_unavailable'
          : 'agent_package_plugin_cache_generation_invalid',
      },
    );
  }
  return resolvedCachePath;
}

function contentLockFiles(lock: AgentPackageLock, cachePath: string) {
  const cacheRoot = path.resolve(cachePath);
  const cacheRootReal = fs.realpathSync(cacheRoot);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const sameFileIdentity = (
    left: fs.BigIntStats,
    right: fs.BigIntStats,
  ) => left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
  return (lock.content_lock_paths ?? []).map((relativePath) => {
    const filePath = path.resolve(cacheRoot, relativePath);
    if (!relativePath.trim()
      || path.isAbsolute(relativePath)
      || filePath === cacheRoot
      || !filePath.startsWith(`${cacheRoot}${path.sep}`)) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Installed package content lock path escapes its immutable cache.',
        {
          package_id: lock.package_id,
          content_lock_path: relativePath,
          codex_plugin_cache_path: cachePath,
          failure_code: 'capability_package_content_lock_path_invalid',
        },
      );
    }
    const fileStat = fs.existsSync(filePath)
      ? fs.lstatSync(filePath, { bigint: true })
      : null;
    if (!fileStat?.isFile() || fileStat.isSymbolicLink()) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Installed package immutable cache is missing a content lock path.',
        {
          package_id: lock.package_id,
          content_lock_path: relativePath,
          codex_plugin_cache_path: cachePath,
          failure_code: 'capability_package_content_lock_path_missing',
        },
      );
    }
    if (fileStat.nlink !== 1n) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Installed package content lock paths must be single-link regular files.',
        {
          package_id: lock.package_id,
          content_lock_path: relativePath,
          codex_plugin_cache_path: cachePath,
          link_count: fileStat.nlink,
          failure_code: 'capability_package_content_lock_hardlink_forbidden',
        },
      );
    }
    const fileReal = fs.realpathSync(filePath);
    if (!fileReal.startsWith(`${cacheRootReal}${path.sep}`)) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Installed package content lock path escapes its immutable cache.',
        {
          package_id: lock.package_id,
          content_lock_path: relativePath,
          codex_plugin_cache_path: cachePath,
          failure_code: 'capability_package_content_lock_path_invalid',
        },
      );
    }
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(fileReal, fs.constants.O_RDONLY | noFollow);
      const before = fs.fstatSync(descriptor, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || !sameFileIdentity(fileStat, before)) {
        throw new FrameworkContractError(
          'contract_shape_invalid',
          'Installed package content lock path changed while it was being read.',
          {
            package_id: lock.package_id,
            content_lock_path: relativePath,
            codex_plugin_cache_path: cachePath,
            failure_code: 'capability_package_content_lock_entry_changed',
          },
        );
      }
      const content = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (!sameFileIdentity(before, after)) {
        throw new FrameworkContractError(
          'contract_shape_invalid',
          'Installed package content lock path changed while it was being read.',
          {
            package_id: lock.package_id,
            content_lock_path: relativePath,
            codex_plugin_cache_path: cachePath,
            failure_code: 'capability_package_content_lock_entry_changed',
          },
        );
      }
      return { path: relativePath, content };
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
    }
  });
}

function assertInstalledSkillContentClosure(lock: AgentPackageLock, cachePath: string) {
  if ((lock.content_lock_paths ?? []).length === 0) return;
  const lockedPaths = new Set(lock.content_lock_paths);
  const skillIds = [...new Set([
    ...(lock.bundled_required_skill_ids ?? []),
    ...(lock.capability_provider?.exports ?? []).map((entry) => entry.skill_id),
  ])];
  const unexpectedPaths: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new FrameworkContractError(
          'contract_shape_invalid',
          'Installed Skill cache only admits regular files and directories.',
          {
            package_id: lock.package_id,
            skill_path: path.relative(cachePath, absolutePath).split(path.sep).join('/'),
            failure_code: 'agent_package_skill_content_lock_entry_unsupported',
          },
        );
      }
      if (stat.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      const relativePath = path.relative(cachePath, absolutePath).split(path.sep).join('/');
      if (!lockedPaths.has(relativePath)) unexpectedPaths.push(relativePath);
    }
  };
  for (const skillId of skillIds) {
    if (!skillId || skillId === '.' || skillId === '..' || path.basename(skillId) !== skillId) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Installed package Skill id must be a safe path segment.',
        {
          package_id: lock.package_id,
          skill_id: skillId,
          failure_code: 'agent_package_skill_projection_id_unsafe',
        },
      );
    }
    const skillRoot = path.join(cachePath, 'skills', skillId);
    if (fs.existsSync(skillRoot) && fs.lstatSync(skillRoot).isDirectory()) visit(skillRoot);
  }
  if (unexpectedPaths.length > 0) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Installed package cache contains projected Skill files outside its content lock.',
      {
        package_id: lock.package_id,
        unexpected_skill_paths: [...new Set(unexpectedPaths)].sort(),
        failure_code: 'agent_package_skill_content_lock_incomplete',
      },
    );
  }
}

export function installedPackageContentLockCanonicalization(
  lock: AgentPackageLock,
  cachePath: string,
): PackageContentLockCanonicalization | null {
  if ((lock.content_lock_paths ?? []).length === 0 || !lock.content_digest) return null;
  const files = contentLockFiles(lock, cachePath);
  if (Object.hasOwn(lock, 'content_lock_canonicalization')) {
    const declaredCanonicalization: unknown = lock.content_lock_canonicalization;
    if (declaredCanonicalization !== CANONICAL_PACKAGE_CONTENT_LOCK
      && declaredCanonicalization !== LEGACY_PACKAGE_CONTENT_LOCK) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Installed package content lock declares an unsupported canonicalization.',
        {
          package_id: lock.package_id,
          declared_content_lock_canonicalization: declaredCanonicalization ?? null,
          codex_plugin_cache_path: cachePath,
          failure_code: 'capability_package_content_lock_canonicalization_invalid',
        },
      );
    }
    if (packageContentLockDigest(declaredCanonicalization, files) !== lock.content_digest) {
      throw new FrameworkContractError(
        'contract_shape_invalid',
        'Installed package immutable cache does not match its declared content lock canonicalization.',
        {
          package_id: lock.package_id,
          declared_content_digest: lock.content_digest,
          declared_content_lock_canonicalization: declaredCanonicalization,
          codex_plugin_cache_path: cachePath,
          failure_code: 'capability_package_content_digest_mismatch',
        },
      );
    }
    assertInstalledSkillContentClosure(lock, cachePath);
    return declaredCanonicalization;
  }
  for (const canonicalization of [
    CANONICAL_PACKAGE_CONTENT_LOCK,
    LEGACY_PACKAGE_CONTENT_LOCK,
  ] as const) {
    if (packageContentLockDigest(canonicalization, files) === lock.content_digest) {
      assertInstalledSkillContentClosure(lock, cachePath);
      return canonicalization;
    }
  }
  throw new FrameworkContractError(
    'contract_shape_invalid',
    'Installed package immutable cache does not match its content lock.',
    {
      package_id: lock.package_id,
      declared_content_digest: lock.content_digest,
      codex_plugin_cache_path: cachePath,
      failure_code: 'capability_package_content_digest_mismatch',
    },
  );
}

export function assertInstalledPackagePluginSource(lock: AgentPackageLock) {
  const sourcePath = installedPackagePluginSourcePath(lock);
  const cachePath = lock.physical_surface?.codex_plugin_cache_path;
  if (!cachePath) return sourcePath;
  const resolvedCachePath = assertImmutableCacheRoot(lock, cachePath);
  if (lock.source_kind !== 'developer_checkout_override') {
    installedPackageContentLockCanonicalization(lock, resolvedCachePath);
  }
  return resolvedCachePath;
}
