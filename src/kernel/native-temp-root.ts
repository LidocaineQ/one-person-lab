import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NON_POSIX_LINUX_FILESYSTEMS = new Set([
  '9p',
  'cifs',
  'drvfs',
  'exfat',
  'fuseblk',
  'ntfs',
  'ntfs3',
  'smb3',
  'vfat',
]);

function decodeMountInfoPath(value: string) {
  return value
    .replace(/\\040/g, ' ')
    .replace(/\\011/g, '\t')
    .replace(/\\012/g, '\n')
    .replace(/\\134/g, '\\');
}

function mountedFilesystemType(candidatePath: string, mountInfo: string | null) {
  if (!mountInfo) return null;
  const candidate = path.resolve(candidatePath);
  let selected: { mountPoint: string; filesystemType: string } | null = null;
  for (const line of mountInfo.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const mountFields = line.slice(0, separator).split(' ');
    const filesystemFields = line.slice(separator + 3).split(' ');
    if (mountFields.length < 5 || filesystemFields.length < 1) continue;
    const mountPoint = path.resolve(decodeMountInfoPath(mountFields[4]!));
    const containsCandidate = mountPoint === path.parse(mountPoint).root
      ? candidate.startsWith(mountPoint)
      : candidate === mountPoint || candidate.startsWith(`${mountPoint}${path.sep}`);
    if (!containsCandidate || (selected && selected.mountPoint.length >= mountPoint.length)) continue;
    selected = { mountPoint, filesystemType: filesystemFields[0]! };
  }
  return selected?.filesystemType ?? null;
}

function readLinuxMountInfo() {
  try {
    return fs.readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return null;
  }
}

export function resolveNativeTemporaryRoot(input: {
  platform?: NodeJS.Platform;
  systemTemporaryRoot?: string;
  linuxMountInfo?: string | null;
  linuxFallbackRoot?: string;
} = {}) {
  const platform = input.platform ?? process.platform;
  const systemTemporaryRoot = path.resolve(input.systemTemporaryRoot ?? os.tmpdir());
  if (platform !== 'linux') return systemTemporaryRoot;
  const mountInfo = input.linuxMountInfo === undefined
    ? readLinuxMountInfo()
    : input.linuxMountInfo;
  const filesystemType = mountedFilesystemType(systemTemporaryRoot, mountInfo);
  return filesystemType && NON_POSIX_LINUX_FILESYSTEMS.has(filesystemType)
    ? path.resolve(input.linuxFallbackRoot ?? '/tmp')
    : systemTemporaryRoot;
}

export function makeNativeTemporaryDirectory(prefix: string) {
  return fs.mkdtempSync(path.join(resolveNativeTemporaryRoot(), prefix));
}
