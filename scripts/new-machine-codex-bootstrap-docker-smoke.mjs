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
opl connect sync-skills --domain mas --domain rca >/tmp/opl-connect-sync-skills.json
opl connect skills --json >/tmp/opl-connect-skills.json
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
  const carrier = packageInstall.configured_carrier;
  if (carrier?.status !== 'installed' || carrier?.executor?.status !== 'callable') {
    throw new Error('native carrier install did not converge for '
      + spec.packageId + ': ' + JSON.stringify(carrier));
  }
  const requiredSkillIds = carrier.executor.required_skill_ids ?? [];
  if (!requiredSkillIds.includes(spec.requiredSkillId)) {
    throw new Error('native carrier omitted required Skill identity for '
      + spec.packageId + ': ' + JSON.stringify(requiredSkillIds));
  }
  if (!carrier.plugin_source_path || !fs.existsSync(carrier.plugin_source_path)) {
    throw new Error('native carrier source is unavailable for '
      + spec.packageId + ': ' + carrier.plugin_source_path);
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
    carrier_source_path: carrier.plugin_source_path,
    required_skill_ids: requiredSkillIds,
    carrier_authority: packageStatus.installed_carrier_readback?.lifecycle_authority,
  };
});

const skillCatalog = readJson('/tmp/opl-connect-skills.json');
const packs = skillCatalog.skill_catalog?.packs ?? [];
const wantedDomains = ['medautoscience', 'redcube'];
for (const domainId of wantedDomains) {
  const pack = packs.find((entry) => entry.domain_id === domainId);
  if (!pack || typeof pack.ready_to_sync !== 'boolean') {
    throw new Error('missing skill pack currentness for ' + domainId + ': ' + JSON.stringify(pack));
  }
  if (pack.foundry_agent_series?.canonical_command_surface !== 'opl agents run') {
    throw new Error('missing Foundry Agent series command surface for ' + domainId);
  }
  if (pack.mcp_projection?.mcp_descriptor_must_delegate_to_series_spine !== true) {
    throw new Error('missing Foundry MCP delegate projection for ' + domainId);
  }
}
const skillSync = readJson('/tmp/opl-connect-sync-skills.json');
const syncOutcomes = (skillSync.skill_sync?.packs ?? [])
  .filter((entry) => wantedDomains.includes(entry.domain_id));
if (syncOutcomes.length !== wantedDomains.length
  || syncOutcomes.some((entry) => !['synced', 'skipped'].includes(entry.sync_status))) {
  throw new Error('skill sync did not report both requested domains: ' + JSON.stringify(syncOutcomes));
}
for (const outcome of syncOutcomes) {
  if (outcome.sync_status === 'synced' && outcome.ready_to_sync !== true) {
    throw new Error('skill sync claimed success without a ready source: ' + JSON.stringify(outcome));
  }
}

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
  skill_sync_outcomes: syncOutcomes.map((entry) => ({
    domain_id: entry.domain_id,
    ready_to_sync: entry.ready_to_sync,
    sync_status: entry.sync_status,
  })),
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
const carrier = packageInstall.configured_carrier;
if (carrier?.status !== 'installed'
  || carrier?.executor?.status !== 'callable'
  || !carrier.plugin_source_path
  || !fs.existsSync(carrier.plugin_source_path)) {
  throw new Error('opl-flow native carrier did not converge: ' + JSON.stringify(carrier));
}

console.log(JSON.stringify({
  status: 'ok',
  surface: 'opl_packages_bootstrap',
  package_status: packageInstall.status,
  carrier_source_path: carrier.plugin_source_path,
  carrier_authority: status.opl_agent_package_status?.installed_carrier_readback?.lifecycle_authority,
  status_readback: status.opl_agent_package_status?.status,
}, null, 2));
NODE

node <<'NODE'
const fs = require('fs');
const path = require('path');
const root = '/tmp/future-agent-lab';
const sourceRoot = path.join(root, 'plugin-source');
const skillRoot = path.join(sourceRoot, 'skills', 'future-agent');
fs.mkdirSync(path.join(sourceRoot, '.codex-plugin'), { recursive: true });
fs.mkdirSync(skillRoot, { recursive: true });
fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Future Agent\n\nIsolated unknown Package fixture.\n');
fs.writeFileSync(path.join(sourceRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
  name: 'future-agent',
  version: '9.1.0',
  description: 'Unknown Package carried by an isolated native adapter.',
  skills: './skills/',
}, null, 2) + '\n');

const presentation = {
  display_name_i18n: { 'zh-CN': '未来智能体实验室', 'en-US': 'Future Agent Lab' },
  description_i18n: {
    'zh-CN': '由所有者清单投影的动态智能体。',
    'en-US': 'A dynamic Agent projected from its owner manifest.',
  },
  session_routing_summary_i18n: {
    'zh-CN': '启动未来研究会话。',
    'en-US': 'Start a future research session.',
  },
  home_shortcuts: [{
    shortcut_id: 'future-main',
    label_i18n: { 'zh-CN': '开始未来研究', 'en-US': 'Start Future Research' },
    default_visible: true,
    user_configurable: true,
    route: {
      route_kind: 'agent_package_shortcut',
      executor: 'codex_cli',
      codex_visible_entry: 'future-agent',
    },
  }],
};
const ownerDescriptor = {
  surface_kind: 'opl_agent_package_manifest.v1',
  package_id: 'future.agent-lab',
  agent_id: 'future-agent',
  display_name: 'Future Agent Lab',
  publisher: 'future-labs',
  version: '9.1.0',
  source: 'third_party',
  carrier_source_role: 'codex_plugin_default_carrier_not_package_truth',
  codex_surface: {
    plugin_ids: ['future-agent'],
    required_skill_ids: ['future-agent'],
    optional_skill_ids: [],
    configured_codex_plugin_carrier: {
      kind: 'codex_plugin_manager',
      plugin_selector: 'future-agent@future-carrier',
      marketplace_source: 'future-carrier',
      executor_route: 'codex_cli',
      publication_ref: null,
    },
  },
  presentation,
  capability_dependencies: [],
  skill_packs: [],
  entrypoints: [{
    shortcut_id: 'future-main',
    label: 'Start Future Research',
    required_skill_ids: ['future-agent'],
    shortcut_eligible: true,
  }],
  update_channel: 'native_carrier',
};
fs.writeFileSync(path.join(sourceRoot, 'opl-package.json'), JSON.stringify(ownerDescriptor, null, 2) + '\n');

const binary = path.join(root, 'fake-codex.mjs');
fs.writeFileSync(binary, [
  '#!/usr/bin/env node',
  "import fs from 'node:fs';",
  "const args = process.argv.slice(2);",
  "const stateFile = process.env.FIXTURE_PLUGIN_STATE;",
  "const sourcePath = process.env.FIXTURE_PLUGIN_SOURCE;",
  "let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { installed: false, version: '9.1.0', marketplaceSource: 'future-carrier' }; // reuse-first: allow test-only fake carrier state boundary.",
  "if (args.join(' ') === 'plugin marketplace list --json') {",
  "  process.stdout.write(JSON.stringify({ marketplaces: state.marketplaceSource ? [{ marketplaceSource: { sourceType: 'local', source: state.marketplaceSource } }] : [] }));",
  "} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {",
  "  state = { ...state, marketplaceSource: args[3] };",
  "  fs.writeFileSync(stateFile, JSON.stringify(state));",
  "  process.stdout.write(JSON.stringify({ status: 'ok' }));",
  "} else if (args[0] === 'plugin' && args[1] === 'add') {",
  "  state = { ...state, installed: true };",
  "  fs.writeFileSync(stateFile, JSON.stringify(state));",
  "  process.stdout.write(JSON.stringify({ status: 'ok' }));",
  "} else if (args[0] === 'plugin' && args[1] === 'remove') {",
  "  state = { ...state, installed: false };",
  "  fs.writeFileSync(stateFile, JSON.stringify(state));",
  "  process.stdout.write(JSON.stringify({ status: 'ok' }));",
  "} else if (args.join(' ') === 'plugin list --available --json') {",
  "  const entry = { pluginId: 'future-agent@future-carrier', version: state.version, enabled: state.installed, source: { source: 'local', path: sourcePath }, marketplaceSource: { sourceType: 'local', source: 'future-carrier' } };",
  "  process.stdout.write(JSON.stringify({ installed: state.installed ? [{ ...entry, installed: true }] : [], available: state.installed ? [] : [{ ...entry, installed: false }] }));",
  "} else if (args.join(' ') === 'plugin list --json') {",
  "  process.stdout.write(JSON.stringify({ installed: state.installed ? [{ pluginId: 'future-agent@future-carrier', version: state.version, installed: true, enabled: true, source: { source: 'local', path: sourcePath }, marketplaceSource: { sourceType: 'local', source: 'future-carrier' } }] : [], available: [] }));",
  "} else {",
  "  process.stderr.write('unexpected fake carrier command: ' + args.join(' '));",
  "  process.exitCode = 2;",
  "}",
  '',
].join('\n'));
fs.chmodSync(binary, 0o755);
NODE

export OPL_CODEX_PLUGIN_BIN=/tmp/future-agent-lab/fake-codex.mjs
export FIXTURE_PLUGIN_STATE=/tmp/future-agent-lab/plugin-state.json
export FIXTURE_PLUGIN_SOURCE=/tmp/future-agent-lab/plugin-source
opl packages install future.agent-lab --json >/tmp/future-agent-install.json
opl packages status --package-id future.agent-lab --json >/tmp/future-agent-status.json
opl packages list --detail full --json >/tmp/future-agent-list.json
opl app state --profile fast --json >/tmp/future-agent-app-state.json

node <<'NODE'
const fs = require('fs');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8')); // reuse-first: allow Docker inline smoke JSON boundary.
const install = readJson('/tmp/future-agent-install.json').opl_agent_package_install;
const status = readJson('/tmp/future-agent-status.json').opl_agent_package_status;
const list = readJson('/tmp/future-agent-list.json').opl_agent_packages;
const appState = readJson('/tmp/future-agent-app-state.json').app_state;
if (install?.status !== 'installed' || install?.package_id !== 'future.agent-lab') {
  throw new Error('unknown Package native install failed: ' + JSON.stringify(install));
}
for (const field of ['package_lock', 'lifecycle_receipt', 'registry_entry', 'opl_private_state_writes']) {
  if (Object.hasOwn(install, field)) {
    throw new Error('unknown Package exposed Framework private state ' + field);
  }
}
if (status?.status !== 'available' || status?.operational_ready !== true || status?.launch_allowed !== true) {
  throw new Error('unknown Package is not callable after native install: ' + JSON.stringify(status));
}
const directoryEntry = list?.directory?.entries?.find((entry) => entry.package_id === 'future.agent-lab');
const appStateEntry = appState?.agent_packages?.directory?.entries?.find(
  (entry) => entry.package_id === 'future.agent-lab',
);
if (!directoryEntry?.installed) {
  throw new Error('unknown Package directory projection is not carrier-owned: ' + JSON.stringify(directoryEntry));
}
if (!appStateEntry?.installed || appStateEntry.display_name !== 'Future Agent Lab') {
  throw new Error('unknown Package App-state projection is missing: ' + JSON.stringify(appStateEntry));
}
console.log(JSON.stringify({
  status: 'ok',
  surface: 'opl_unknown_package_isolation',
  package_id: directoryEntry.package_id,
  installed: directoryEntry.installed,
  carrier_kind: directoryEntry.installed_carrier_readback?.kind,
  app_state_display_name: appStateEntry.display_name,
  app_state_home_shortcuts: appStateEntry.home_shortcuts,
  native_carrier_is_lifecycle_authority: directoryEntry.installed_carrier_readback?.lifecycle_authority === 'carrier_owned',
}, null, 2));
NODE

opl packages uninstall future.agent-lab --json >/tmp/future-agent-uninstall.json
opl packages status --package-id future.agent-lab --json >/tmp/future-agent-after-remove.json

node <<'NODE'
const fs = require('fs');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8')); // reuse-first: allow Docker inline smoke JSON boundary.
const removed = readJson('/tmp/future-agent-uninstall.json').opl_agent_package_uninstall;
const after = readJson('/tmp/future-agent-after-remove.json').opl_agent_package_status;
if (removed?.status !== 'uninstalled' || after?.status !== 'not_installed') {
  throw new Error('unknown Package native removal did not converge: '
    + JSON.stringify({ removed, after }));
}
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
