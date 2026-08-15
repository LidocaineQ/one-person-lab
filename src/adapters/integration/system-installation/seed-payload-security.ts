import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { stringValue } from '../../../kernel/json-record.ts';

type SeedPayloadComponentId =
  | 'opl_framework'
  | 'codex_cli'
  | 'companion_skills'
  | 'domain_modules';

export type SeedMaterializationMode = 'copy_to_data_volume' | 'preheated_in_image';

export type SeedPayloadMaterialization = {
  source_path: string | null;
  materialized_path: string | null;
  sha256: string | null;
  size_bytes: number | null;
};

const TARGET_PATHS: Record<SeedPayloadComponentId, string[]> = {
  opl_framework: ['opl', 'framework'],
  codex_cli: ['opl', 'toolchains', 'codex'],
  companion_skills: ['opl', 'skills'],
  domain_modules: ['opl', 'modules'],
};

function fail(message: string, failureCode: string, details: Record<string, unknown>): never {
  throw new FrameworkContractError('contract_shape_invalid', message, {
    ...details,
    failure_code: failureCode,
  });
}

function isPathInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function lstatOrNull(filePath: string) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeDeclaredSha256(
  componentId: SeedPayloadComponentId,
  component: Record<string, unknown> | null,
) {
  const values = [
    stringValue(component?.sha256),
    stringValue(component?.checksum_sha256),
  ].filter((value): value is string => Boolean(value));
  if (values.length === 0) return null;
  const normalized = values.map((value) => {
    const match = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(value);
    if (!match) {
      fail('Seed payload sha256 must be a 64-character hexadecimal digest.', 'opl_seed_payload_digest_invalid', {
        component_id: componentId,
        declared_sha256: value,
      });
    }
    return match[1].toLowerCase();
  });
  if (new Set(normalized).size !== 1) {
    fail('Seed payload sha256 declarations disagree.', 'opl_seed_payload_digest_invalid', {
      component_id: componentId,
      declared_sha256: values,
    });
  }
  return normalized[0];
}

function inspectPayload(
  componentId: SeedPayloadComponentId,
  payloadPath: string,
  pathKind: 'payload' | 'materialized',
) {
  const files: string[] = [];
  const stack = [payloadPath];
  let sizeBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      fail('Seed payload symbolic links are not allowed.', `opl_seed_${pathKind}_symlink_forbidden`, {
        component_id: componentId,
        path: current,
      });
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (!stat.isFile()) {
      fail(
        'Seed payloads may contain only regular files and directories.',
        `opl_seed_${pathKind}_special_file_forbidden`,
        { component_id: componentId, path: current },
      );
    }
    if (stat.nlink > 1) {
      fail('Seed payload hard links are not allowed.', `opl_seed_${pathKind}_hardlink_forbidden`, {
        component_id: componentId,
        path: current,
        link_count: stat.nlink,
      });
    }
    files.push(current);
    sizeBytes += stat.size;
  }

  if (files.length === 1 && files[0] === payloadPath) {
    return {
      sha256: crypto.createHash('sha256').update(fs.readFileSync(payloadPath)).digest('hex'),
      size_bytes: sizeBytes,
    };
  }
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    hash.update(path.relative(payloadPath, file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), size_bytes: sizeBytes };
}

function resolvePayloadPath(
  seedDir: string | null,
  componentId: SeedPayloadComponentId,
  component: Record<string, unknown> | null,
) {
  const payload = stringValue(component?.payload_path);
  if (!payload) return null;
  if (!seedDir) {
    fail('Seed payloads require an explicit seed root.', 'opl_seed_payload_root_required', {
      component_id: componentId,
      payload_path: payload,
    });
  }
  const logicalRoot = path.resolve(seedDir);
  const rootStat = lstatOrNull(logicalRoot);
  if (!rootStat || !fs.statSync(logicalRoot).isDirectory()) {
    fail('Seed payload root is missing or is not a directory.', 'opl_seed_payload_root_invalid', {
      component_id: componentId,
      seed_root: logicalRoot,
      payload_path: payload,
    });
  }
  const realRoot = fs.realpathSync(logicalRoot);
  const candidate = path.isAbsolute(payload) ? path.resolve(payload) : path.resolve(logicalRoot, payload);
  const relative = isPathInside(logicalRoot, candidate)
    ? path.relative(logicalRoot, candidate)
    : isPathInside(realRoot, candidate)
      ? path.relative(realRoot, candidate)
      : null;
  if (relative === null) {
    fail('Seed payload path escapes the configured seed root.', 'opl_seed_payload_path_outside_seed_root', {
      component_id: componentId,
      seed_root: realRoot,
      payload_path: candidate,
    });
  }

  let current = realRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      fail('Seed payload symbolic links are not allowed.', 'opl_seed_payload_symlink_forbidden', {
        component_id: componentId,
        path: current,
      });
    }
  }
  if (lstatOrNull(candidate)) {
    const realCandidate = fs.realpathSync(candidate);
    if (realCandidate !== path.resolve(realRoot, relative) || !isPathInside(realRoot, realCandidate)) {
      fail('Seed payload symbolic links are not allowed.', 'opl_seed_payload_symlink_forbidden', {
        component_id: componentId,
        path: candidate,
        resolved_path: realCandidate,
      });
    }
  }
  return candidate;
}

function assertSafeTargetPath(
  componentId: SeedPayloadComponentId,
  dataDir: string,
  targetPath: string,
) {
  const logicalRoot = path.resolve(dataDir);
  const realRoot = fs.realpathSync(logicalRoot);
  const candidate = path.resolve(targetPath);
  if (!isPathInside(logicalRoot, candidate)) {
    fail('Seed materialized path escapes the configured data root.', 'opl_seed_materialized_path_unsafe', {
      component_id: componentId,
      data_root: realRoot,
      target_path: candidate,
    });
  }
  const relative = path.relative(logicalRoot, candidate);
  let current = realRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      fail(
        'Seed materialized paths may not traverse symbolic links.',
        'opl_seed_materialized_symlink_forbidden',
        { component_id: componentId, path: current },
      );
    }
  }
  if (lstatOrNull(candidate)) {
    const realCandidate = fs.realpathSync(candidate);
    if (realCandidate !== path.resolve(realRoot, relative) || !isPathInside(realRoot, realCandidate)) {
      fail(
        'Seed materialized paths may not traverse symbolic links.',
        'opl_seed_materialized_symlink_forbidden',
        { component_id: componentId, path: candidate, resolved_path: realCandidate },
      );
    }
  }
}

export function materializeSeedPayload(input: {
  componentId: SeedPayloadComponentId;
  seedDir: string | null;
  component: Record<string, unknown> | null;
  dataDir: string | null;
  mode: SeedMaterializationMode;
}): SeedPayloadMaterialization {
  const { componentId, seedDir, component, dataDir, mode } = input;
  const sourcePath = resolvePayloadPath(seedDir, componentId, component);
  const declaredSha256 = normalizeDeclaredSha256(componentId, component);
  const sourceStat = sourcePath ? lstatOrNull(sourcePath) : null;
  if (!sourcePath || !sourceStat) {
    return { source_path: sourcePath, materialized_path: null, sha256: null, size_bytes: null };
  }
  const source = inspectPayload(componentId, sourcePath, 'payload');
  if (declaredSha256 && declaredSha256 !== source.sha256) {
    fail('Seed payload sha256 does not match the declared digest.', 'opl_seed_payload_digest_mismatch', {
      component_id: componentId,
      payload_path: sourcePath,
      expected_sha256: declaredSha256,
      actual_sha256: source.sha256,
    });
  }
  if (mode === 'preheated_in_image') {
    return {
      source_path: sourcePath,
      materialized_path: sourcePath,
      sha256: source.sha256,
      size_bytes: source.size_bytes,
    };
  }
  if (!dataDir) {
    return {
      source_path: sourcePath,
      materialized_path: null,
      sha256: source.sha256,
      size_bytes: source.size_bytes,
    };
  }

  const targetRoot = path.join(dataDir, ...TARGET_PATHS[componentId]);
  const targetPath = sourceStat.isDirectory() ? targetRoot : path.join(targetRoot, path.basename(sourcePath));
  assertSafeTargetPath(componentId, dataDir, targetPath);
  if (lstatOrNull(targetPath)) {
    const existing = inspectPayload(componentId, targetPath, 'materialized');
    if (existing.sha256 !== source.sha256) {
      fail('Existing Seed materialized target has different bytes.', 'opl_seed_materialized_target_conflict', {
        component_id: componentId,
        target_path: targetPath,
        expected_sha256: source.sha256,
        actual_sha256: existing.sha256,
      });
    }
    return {
      source_path: sourcePath,
      materialized_path: targetPath,
      sha256: source.sha256,
      size_bytes: source.size_bytes,
    };
  }

  let createdTarget = false;
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    assertSafeTargetPath(componentId, dataDir, targetPath);
    if (sourceStat.isDirectory()) {
      fs.cpSync(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: true });
    } else {
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    }
    createdTarget = true;
    assertSafeTargetPath(componentId, dataDir, targetPath);
    const materialized = inspectPayload(componentId, targetPath, 'materialized');
    if (materialized.sha256 !== source.sha256) {
      fail('Seed materialized bytes do not match the verified payload.', 'opl_seed_materialized_digest_mismatch', {
        component_id: componentId,
        target_path: targetPath,
        expected_sha256: source.sha256,
        actual_sha256: materialized.sha256,
      });
    }
  } catch (error) {
    if (createdTarget) fs.rmSync(targetPath, { recursive: true, force: true });
    throw error;
  }
  return {
    source_path: sourcePath,
    materialized_path: targetPath,
    sha256: source.sha256,
    size_bytes: source.size_bytes,
  };
}
