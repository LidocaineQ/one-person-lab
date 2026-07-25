import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import {
  modeAwarePackageContentLockDigest,
  type ModeAwarePackageContentLockFile,
} from './payload-content-lock.ts';

export type SelectedBundlePackageRecord = {
  packageId: string;
  carrierRoot: string;
  ownerManifestPath: string;
  pluginManifestPath: string;
};

type DescriptorFile = {
  relative_path: string;
  sha256: string;
  mode: '100644' | '100755';
};

type CapturedBundlePackage = {
  package_id: string;
  carrier_root: string;
  owner_manifest: DescriptorFile;
  plugin_manifest: DescriptorFile & { plugin_id: string | null };
  skill_roots: Array<{
    relative_path: string;
    entry_paths: string[];
    resources: DescriptorFile[];
    digest: string;
  }>;
  digest: string;
};

function descriptorFailure(message: string, details: Record<string, unknown>) {
  return new FrameworkContractError('contract_shape_invalid', message, {
    ...details,
    failure_code: 'resolved_selected_bundle_descriptor_invalid',
  });
}

function sha256(content: Buffer) {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizedRelativePath(value: string, field: string, packageId: string) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw descriptorFailure('Selected Bundle descriptor paths must be non-empty strings.', {
      package_id: packageId,
      field,
    });
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\//, '');
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw descriptorFailure('Selected Bundle descriptor paths must remain inside their carrier root.', {
      package_id: packageId,
      field,
      value,
    });
  }
  return normalized;
}

function requireRegularFile(root: string, relativePath: string, packageId: string, field: string) {
  const candidate = path.resolve(root, relativePath);
  if (!isInside(root, candidate) || !fs.existsSync(candidate)) {
    throw descriptorFailure('Selected Bundle descriptor file is missing or escapes its carrier root.', {
      package_id: packageId,
      field,
      relative_path: relativePath,
    });
  }
  const before = fs.lstatSync(candidate);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw descriptorFailure('Selected Bundle descriptor files must be regular non-symlink files.', {
      package_id: packageId,
      field,
      relative_path: relativePath,
    });
  }
  const real = fs.realpathSync(candidate);
  if (!isInside(root, real)) {
    throw descriptorFailure('Selected Bundle descriptor file escapes its carrier root through an intermediate path.', {
      package_id: packageId,
      field,
      relative_path: relativePath,
    });
  }
  const content = fs.readFileSync(real);
  const verificationContent = fs.readFileSync(real);
  const after = fs.statSync(real);
  if (!after.isFile()
    || (before.mode & 0o111) !== (after.mode & 0o111)
    || !content.equals(verificationContent)) {
    throw descriptorFailure('Selected Bundle descriptor file changed while it was captured.', {
      package_id: packageId,
      field,
      relative_path: relativePath,
    });
  }
  return {
    absolutePath: real,
    file: {
      relative_path: relativePath,
      sha256: sha256(content),
      mode: after.mode & 0o111 ? '100755' as const : '100644' as const,
    },
    content,
  };
}

function collectDirectoryFiles(root: string, current: string, packageId: string, files: Map<string, ModeAwarePackageContentLockFile>) {
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw descriptorFailure('Selected Bundle skill closure does not admit symbolic links or special files.', {
      package_id: packageId,
      source_path: current,
    });
  }
  if (stat.isFile()) {
    const relativePath = path.relative(root, current).split(path.sep).join('/');
    if (files.has(relativePath)) {
      throw descriptorFailure('Selected Bundle skill closure has a duplicate target path.', {
        package_id: packageId,
        relative_path: relativePath,
      });
    }
    const content = fs.readFileSync(current);
    const verificationContent = fs.readFileSync(current);
    const after = fs.statSync(current);
    if (!after.isFile()
      || (stat.mode & 0o111) !== (after.mode & 0o111)
      || !content.equals(verificationContent)) {
      throw descriptorFailure('Selected Bundle skill resource changed while its closure was captured.', {
        package_id: packageId,
        relative_path: relativePath,
      });
    }
    files.set(relativePath, {
      path: relativePath,
      content,
      mode: after.mode & 0o111 ? '100755' : '100644',
    });
    return;
  }
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    collectDirectoryFiles(root, path.join(current, entry.name), packageId, files);
  }
}

function declaredSkillRoots(pluginManifest: Record<string, unknown>, packageId: string) {
  const raw = pluginManifest.skills;
  if (raw === undefined || raw === null) return [];
  const values = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (!values || values.some((value) => typeof value !== 'string')) {
    throw descriptorFailure('Selected Bundle plugin manifest skills must be a string or a string array.', {
      package_id: packageId,
    });
  }
  const roots = values.map((value) => normalizedRelativePath(value, 'plugin_manifest.skills', packageId));
  if (new Set(roots).size !== roots.length) {
    throw descriptorFailure('Selected Bundle plugin manifest declares duplicate skill roots.', {
      package_id: packageId,
      skill_roots: roots,
    });
  }
  return roots;
}

function captureSelectedPackage(record: SelectedBundlePackageRecord): CapturedBundlePackage {
  if (!record.packageId || typeof record.packageId !== 'string') {
    throw descriptorFailure('Selected Bundle records require a package id.', { package_id: record.packageId ?? null });
  }
  const carrierCandidate = path.resolve(record.carrierRoot);
  if (!fs.existsSync(carrierCandidate) || !fs.lstatSync(carrierCandidate).isDirectory() || fs.lstatSync(carrierCandidate).isSymbolicLink()) {
    throw descriptorFailure('Selected Bundle carrier root must be a regular directory.', {
      package_id: record.packageId,
      carrier_root: carrierCandidate,
    });
  }
  const carrierRoot = fs.realpathSync(carrierCandidate);
  const ownerManifestPath = normalizedRelativePath(record.ownerManifestPath, 'owner_manifest_path', record.packageId);
  const pluginManifestPath = normalizedRelativePath(record.pluginManifestPath, 'plugin_manifest_path', record.packageId);
  const ownerManifest = requireRegularFile(carrierRoot, ownerManifestPath, record.packageId, 'owner_manifest_path');
  const pluginManifest = requireRegularFile(carrierRoot, pluginManifestPath, record.packageId, 'plugin_manifest_path');
  const pluginPayload = parseJsonText(pluginManifest.content.toString('utf8'));
  if (!isRecord(pluginPayload)) {
    throw descriptorFailure('Selected Bundle plugin manifest must be a JSON object.', {
      package_id: record.packageId,
      plugin_manifest_path: pluginManifestPath,
    });
  }
  const pluginRoot = path.dirname(path.dirname(pluginManifest.absolutePath));
  if (!isInside(carrierRoot, pluginRoot)) {
    throw descriptorFailure('Selected Bundle plugin root escapes its carrier root.', {
      package_id: record.packageId,
      plugin_manifest_path: pluginManifestPath,
    });
  }
  const skillRoots = declaredSkillRoots(pluginPayload, record.packageId).map((declaredPath) => {
    const absoluteRoot = path.resolve(pluginRoot, declaredPath);
    if (!isInside(pluginRoot, absoluteRoot) || !fs.existsSync(absoluteRoot)) {
      throw descriptorFailure('Selected Bundle skill root is missing or escapes its plugin root.', {
        package_id: record.packageId,
        skill_root: declaredPath,
      });
    }
    const rootStat = fs.lstatSync(absoluteRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw descriptorFailure('Selected Bundle skill roots must be regular directories.', {
        package_id: record.packageId,
        skill_root: declaredPath,
      });
    }
    const skillRootReal = fs.realpathSync(absoluteRoot);
    if (skillRootReal !== absoluteRoot || !isInside(pluginRoot, skillRootReal)) {
      throw descriptorFailure('Selected Bundle skill root escapes its plugin root through an intermediate symbolic link.', {
        package_id: record.packageId,
        skill_root: declaredPath,
        resolved_skill_root: skillRootReal,
      });
    }
    const files = new Map<string, ModeAwarePackageContentLockFile>();
    collectDirectoryFiles(carrierRoot, absoluteRoot, record.packageId, files);
    const resources = [...files.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'));
    const entryPaths = resources.filter((file) => file.path.endsWith('/SKILL.md') || file.path === 'SKILL.md').map((file) => file.path);
    if (entryPaths.length === 0) {
      throw descriptorFailure('Selected Bundle skill roots must contain a SKILL.md entry point.', {
        package_id: record.packageId,
        skill_root: declaredPath,
      });
    }
    return {
      relative_path: path.relative(carrierRoot, absoluteRoot).split(path.sep).join('/'),
      entry_paths: entryPaths,
      resources: resources.map(({ path: relativePath, content, mode }) => ({
        relative_path: relativePath,
        sha256: sha256(content),
        mode,
      })),
      digest: modeAwarePackageContentLockDigest(resources),
    };
  });
  const allFiles = new Map<string, ModeAwarePackageContentLockFile>();
  for (const manifest of [ownerManifest, pluginManifest]) {
    allFiles.set(manifest.file.relative_path, {
      path: manifest.file.relative_path,
      content: manifest.content,
      mode: manifest.file.mode,
    });
  }
  for (const skillRoot of skillRoots) {
    for (const resource of skillRoot.resources) {
      const absolutePath = path.resolve(carrierRoot, resource.relative_path);
      if (allFiles.has(resource.relative_path)) {
        throw descriptorFailure('Selected Bundle closure has a duplicate target path.', {
          package_id: record.packageId,
          relative_path: resource.relative_path,
        });
      }
      const content = fs.readFileSync(absolutePath);
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile()
        || sha256(content) !== resource.sha256
        || (stat.mode & 0o111 ? '100755' : '100644') !== resource.mode) {
        throw descriptorFailure('Selected Bundle skill resource changed after its closure was captured.', {
          package_id: record.packageId,
          relative_path: resource.relative_path,
        });
      }
      allFiles.set(resource.relative_path, {
        path: resource.relative_path,
        content,
        mode: resource.mode,
      });
    }
  }
  const pluginId = typeof pluginPayload.name === 'string' && pluginPayload.name.trim() !== '' ? pluginPayload.name : null;
  return {
    package_id: record.packageId,
    carrier_root: carrierRoot,
    owner_manifest: ownerManifest.file,
    plugin_manifest: { ...pluginManifest.file, plugin_id: pluginId },
    skill_roots: skillRoots,
    digest: modeAwarePackageContentLockDigest([...allFiles.values()]),
  };
}

function assertUniqueSkillMaterializationTargets(packages: CapturedBundlePackage[]) {
  const targets = new Map<string, { packageId: string; entryPath: string }>();
  for (const packageEntry of packages) {
    for (const skillRoot of packageEntry.skill_roots) {
      for (const entryPath of skillRoot.entry_paths) {
        const targetName = path.posix.basename(path.posix.dirname(entryPath));
        if (!targetName || targetName === '.' || targetName === '..') {
          throw descriptorFailure('Selected Bundle Skill entry does not resolve to a safe materialization target.', {
            package_id: packageEntry.package_id,
            entry_path: entryPath,
            materialization_target: targetName,
          });
        }
        const previous = targets.get(targetName);
        if (previous) {
          throw descriptorFailure('Selected Bundle Skill materialization targets must be unique across selected packages.', {
            materialization_target: targetName,
            package_ids: [previous.packageId, packageEntry.package_id],
            entry_paths: [previous.entryPath, entryPath],
          });
        }
        targets.set(targetName, {
          packageId: packageEntry.package_id,
          entryPath,
        });
      }
    }
  }
}

export function resolveSelectedBundleDescriptor(selectedPackages: SelectedBundlePackageRecord[]) {
  if (!Array.isArray(selectedPackages)) {
    throw descriptorFailure('Selected Bundle descriptor input must be an ordered array.', {});
  }
  const packageIds = selectedPackages.map((record) => record?.packageId);
  if (packageIds.some((packageId) => typeof packageId !== 'string' || packageId.length === 0)
    || new Set(packageIds).size !== packageIds.length) {
    throw descriptorFailure('Selected Bundle descriptor package ids must be unique ordered strings.', { package_ids: packageIds });
  }
  const packages = selectedPackages.map(captureSelectedPackage);
  assertUniqueSkillMaterializationTargets(packages);
  const bundleDigest = crypto.createHash('sha256')
    .update(packages.map((entry) => `${entry.package_id}\0${entry.digest}\0`).join(''))
    .digest('hex');
  return {
    descriptor_kind: 'internal_resolved_selected_bundle',
    package_ids: packages.map((entry) => entry.package_id),
    packages,
    digest: `sha256:${bundleDigest}`,
  };
}
