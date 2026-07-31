#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const image = process.env.OPL_BOOTSTRAP_SMOKE_IMAGE || 'node:22-bookworm';
const sourceRoot = fs.realpathSync(process.env.OPL_BOOTSTRAP_SMOKE_SOURCE_ROOT || process.cwd());
const sourceStatus = execFileSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all'],
  { cwd: sourceRoot, encoding: 'utf8' },
).trim();
if (sourceStatus) {
  throw new Error('Docker bootstrap smoke requires a clean committed Framework source tree.');
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: sourceRoot,
  encoding: 'utf8',
}).trim();
const sourceArchiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-bootstrap-smoke-source-'));
const sourceArchivePath = path.join(sourceArchiveRoot, 'one-person-lab.tar.gz');
execFileSync(
  'git',
  ['archive', '--format=tar.gz', '--prefix=one-person-lab/', '-o', sourceArchivePath, sourceCommit],
  { cwd: sourceRoot, stdio: 'inherit' },
);

const smokeScript = String.raw`
set -euo pipefail

export CI=1
export OPL_COMPANION_DISABLE_REMOTE_INSTALL=1
export OPL_MODULES_ROOT=/root/.opl/state/modules
export OPL_STATE_DIR=/root/.opl/state
export CODEX_HOME=/root/.codex
export OPL_INSTALL_SOURCE_MODE=archive
export OPL_SOURCE_ARCHIVE_URL=file:///tmp/opl-framework-source.tar.gz
export OPL_FRAMEWORK_SOURCE_COMMIT=${sourceCommit}
mkdir -p "$CODEX_HOME"

node -v
npm -v
git --version

curl -fsSL https://raw.githubusercontent.com/gaofeng21cn/one-person-lab-app/main/install.sh \
  | bash -s -- --headless --skip-packages --skip-engines --skip-native-helper-repair --no-online-runtime

opl help --text >/tmp/opl-help.txt
opl system initialize --json >/tmp/opl-system.json
opl packages install mas --json >/tmp/opl-mas-install.json
opl packages install rca --json >/tmp/opl-rca-install.json
opl packages status --package-id mas --json >/tmp/opl-mas-status.json
opl packages status --package-id rca --json >/tmp/opl-rca-status.json
opl packages install opl-flow --json >/tmp/opl-flow-install.json
opl packages status --package-id opl-flow --json >/tmp/opl-flow-status.json

node <<'NODE'
const fs = require('fs');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8')); // reuse-first: allow Docker inline smoke JSON boundary.
const packages = [
  {
    packageId: 'mas',
    installFile: '/tmp/opl-mas-install.json',
    statusFile: '/tmp/opl-mas-status.json',
    requiredSkillId: 'med-autoscience',
  },
  {
    packageId: 'rca',
    installFile: '/tmp/opl-rca-install.json',
    statusFile: '/tmp/opl-rca-status.json',
    requiredSkillId: 'redcube-ai',
  },
].map((spec) => {
  const packageInstall = readJson(spec.installFile).opl_agent_package_install;
  const packageStatus = readJson(spec.statusFile).opl_agent_package_status;
  if (packageInstall?.status !== 'installed' || packageInstall?.package_id !== spec.packageId) {
    throw new Error('package install failed for ' + spec.packageId + ': ' + JSON.stringify(packageInstall));
  }
  const physicalSurface = packageInstall.physical_surface;
  const profile = physicalSurface?.profile_migration;
  if (profile?.status !== 'not_requested' || profile?.writes_performed !== false) {
    throw new Error('package profile metadata escaped owner-managed no-write handling for '
      + spec.packageId + ': ' + JSON.stringify(profile));
  }
  const requiredSkillPaths = physicalSurface?.materialized_required_skill_paths ?? [];
  if (!requiredSkillPaths.some((filePath) => filePath.endsWith('/skills/' + spec.requiredSkillId + '/SKILL.md'))) {
    throw new Error('missing required skill path for ' + spec.packageId + ': ' + JSON.stringify(requiredSkillPaths));
  }
  for (const filePath of [physicalSurface?.plugin_manifest_path, ...requiredSkillPaths]) {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('missing package surface for ' + spec.packageId + ': ' + filePath);
    }
  }
  if (packageStatus?.status !== 'available'
    || packageStatus?.operational_ready !== true
    || packageStatus?.launch_allowed !== true) {
    throw new Error('package status is not ready for ' + spec.packageId + ': ' + JSON.stringify(packageStatus));
  }
  return {
    package_id: spec.packageId,
    install_status: packageInstall.status,
    status: packageStatus.status,
    plugin_manifest_path: physicalSurface.plugin_manifest_path,
    required_skill_paths: requiredSkillPaths,
    profile_status: profile.status,
    writes_performed: profile.writes_performed,
  };
});

if (fs.existsSync('/root/.opl/state/modules/med-autoscience')
  || fs.existsSync('/root/.opl/state/modules/redcube')) {
  throw new Error('Package bootstrap unexpectedly materialized legacy Module roots.');
}

const bareMirrors = ['mas', 'rca']
  .filter((name) => fs.existsSync('/root/.codex/skills/' + name + '/SKILL.md'));
if (bareMirrors.length) {
  throw new Error('unexpected bare skill mirrors: ' + bareMirrors.join(','));
}

console.log(JSON.stringify({
  status: 'ok',
  surface: 'opl_mas_rca_bootstrap',
  help_has_opl: fs.readFileSync('/tmp/opl-help.txt', 'utf8').includes('One Person Lab'),
  packages,
  no_bare_skill_mirrors: true,
  no_legacy_module_roots: true,
}, null, 2));
NODE

node <<'NODE'
const fs = require('fs');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8')); // reuse-first: allow Docker inline smoke JSON boundary.
const install = readJson('/tmp/opl-flow-install.json');
const status = readJson('/tmp/opl-flow-status.json');
const packageInstall = install.opl_agent_package_install;
if (packageInstall?.status !== 'installed') {
  throw new Error('opl-flow package install failed: ' + JSON.stringify(install));
}
const profile = packageInstall.physical_surface?.profile_migration;
if (profile?.status !== 'not_requested' || profile?.writes_performed !== false) {
  throw new Error('opl-flow profile metadata escaped owner-managed no-write handling: ' + JSON.stringify(profile));
}
for (const filePath of [
  packageInstall.physical_surface.plugin_manifest_path,
  ...packageInstall.physical_surface.materialized_required_skill_paths,
]) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('missing opl-flow package surface: ' + filePath);
  }
}

console.log(JSON.stringify({
  status: 'ok',
  surface: 'opl_packages_bootstrap',
  package_status: packageInstall.status,
  profile_status: profile.status,
  plugin_path: packageInstall.physical_surface.codex_plugin_cache_path,
  status_readback: status.opl_agent_package_status?.status,
}, null, 2));
NODE
`;

try {
  const result = spawnSync(
    'docker',
    [
      'run',
      '-i',
      '--rm',
      '--mount',
      `type=bind,source=${sourceArchivePath},target=/tmp/opl-framework-source.tar.gz,readonly`,
      image,
      'bash',
      '-s',
    ],
    {
      input: smokeScript,
      encoding: 'utf8',
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(sourceArchiveRoot, { recursive: true, force: true });
}
