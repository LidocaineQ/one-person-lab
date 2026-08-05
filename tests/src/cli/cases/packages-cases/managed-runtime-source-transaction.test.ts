import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import { removeFixtureTree } from '../../helpers.ts';
import { parseJsonText } from '../../../../../src/kernel/json-file.ts';
import {
  agentPackageManifest,
  assert,
  createPluginSourceFixture,
  formatJsonPayload,
  fs,
  os,
  path,
  runCli,
  runCliFailure,
  test,
} from './helpers.ts';
import {
  scholarSkillsCoreSkillIds,
  scholarSkillsModuleIds,
  writeCapabilityCatalog,
  writeCapabilityProvider,
  writeMasConsumer,
} from './capability-fixtures.ts';
import { writeManagedRuntimeSourceFixture } from './managed-runtime-source-fixture.ts';
import {
  applyManagedRuntimeSourceCarrier,
  finalizeManagedRuntimeSourceMutation,
  inspectManagedRuntimeSourceTransactions,
  managedRuntimeSourceReadiness,
  recoverManagedRuntimeSourceTransactions,
  rollbackManagedRuntimeSourceMutation,
} from '../../../../../src/modules/connect/agent-package-registry-parts/managed-runtime-source-carrier.ts';
import {
  finalizePluginGenerationMutation,
  materializeImmutablePluginCache,
  materializeImmutablePluginCacheTransaction,
  restorePluginGenerationMutation,
} from '../../../../../src/modules/connect/agent-package-registry-parts/physical-surface.ts';
import { developerCheckoutPayloadDigest } from '../../../../../src/modules/connect/agent-package-registry-parts/developer-checkout-package-source.ts';
import { installedPackageContentLockCanonicalization } from '../../../../../src/modules/connect/agent-package-registry-parts/installed-plugin-source.ts';
import {
  CANONICAL_PACKAGE_CONTENT_LOCK,
  LEGACY_PACKAGE_CONTENT_LOCK,
  packageContentLockDigest,
} from '../../../../../src/modules/connect/agent-package-registry-parts/payload-content-lock.ts';
import {
  computePackageChannelTreeSha256,
  readPackageChannelLifecycle,
  rollbackManagedModulePackageChannel,
} from '../../../../../src/modules/connect/system-installation/module-package-channel.ts';
import { resolveOplDomainModuleSpec } from '../../../../../src/modules/connect/system-installation/modules.ts';
import { readDeveloperCheckoutSourceIdentity } from '../../../../../src/modules/connect/agent-package-registry-parts/developer-checkout-runtime-source.ts';

const FIXTURE_MAS_PACKAGE_ID = 'fixture.mas';
const FIXTURE_MAG_PACKAGE_ID = 'fixture.mag';
const FIXTURE_RCA_PACKAGE_ID = 'fixture.rca';
const FIXTURE_PROVIDER_PACKAGE_ID = 'fixture.mas-scholar-skills';

function withProcessEnvironment<T>(
  environment: Record<string, string>,
  action: () => T,
) {
  const previous = new Map(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, environment);
  try {
    return action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function inspectPrivateRuntimeSourceRecovery(
  statusReadback: any,
  environment: Record<string, string>,
) {
  assert.equal(
    Object.hasOwn(statusReadback.opl_agent_package_status, 'runtime_source_recovery'),
    false,
  );
  return withProcessEnvironment(environment, inspectManagedRuntimeSourceTransactions);
}

test('developer plugin cache publishes one stage directly into its immutable generation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-developer-plugin-stage-'));
  const targetPath = path.join(root, 'cache', 'fixture.plugin', '0.1.26-dev');
  const payloadFiles = [
    {
      path: '.codex-plugin/plugin.json',
      content: Buffer.from(formatJsonPayload({ name: 'fixture.plugin', version: '0.1.26' })),
      mode: '100644' as const,
    },
    {
      path: 'skills/fixture.plugin/SKILL.md',
      content: Buffer.from('# Fixture Plugin\n'),
      mode: '100644' as const,
    },
  ];
  const renameCalls: Array<{ from: string; to: string; sourceMode: number }> = [];
  const originalRenameSync = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    const sourceMode = fs.lstatSync(from).mode & 0o777;
    renameCalls.push({ from: String(from), to: String(to), sourceMode });
    if ((sourceMode & 0o200) === 0) {
      const error = new Error('simulated macOS frozen-directory rename denial') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    originalRenameSync(from, to);
  }) as typeof fs.renameSync;
  try {
    const created = materializeImmutablePluginCache({
      manifest: {
        package_id: 'fixture.plugin',
        required_skill_ids: ['fixture.plugin'],
        content_lock_paths: [],
        developer_checkout_source: {
          copy_paths: payloadFiles.map((entry) => entry.path),
          copy_file_modes: Object.fromEntries(payloadFiles.map((entry) => [entry.path, entry.mode])),
          payload_digest: developerCheckoutPayloadDigest(payloadFiles),
        },
      } as any,
      sourcePath: root,
      targetPath,
      developerCheckoutPayloadFiles: payloadFiles,
    });
    assert.equal(created, true);
    assert.deepEqual(renameCalls.map((entry) => entry.to), [targetPath]);
    assert.deepEqual(renameCalls.map((entry) => entry.sourceMode), [0o755]);
    assert.match(
      path.basename(renameCalls[0].from),
      new RegExp(`^\\.${path.basename(targetPath)}\\.stage-`),
    );
    assert.equal(fs.existsSync(targetPath), true);
    assert.equal(fs.lstatSync(targetPath).mode & 0o777, 0o555);
    assert.equal(
      fs.readdirSync(path.dirname(targetPath)).some((entry) => entry.includes('.stage-')),
      false,
    );
  } finally {
    fs.renameSync = originalRenameSync;
    removeFixtureTree(root);
  }
});
test('installed content lock honors explicit canonicalization and limits probing to legacy omissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-content-lock-canonicalization-'));
  const relativePath = 'skills/fixture.plugin/SKILL.md';
  const content = Buffer.from('# Fixture Plugin\n');
  const targetPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content);
  const files = [{ path: relativePath, content }];
  const lock = {
    package_id: 'fixture.plugin',
    content_lock_paths: [relativePath],
    content_lock_canonicalization: CANONICAL_PACKAGE_CONTENT_LOCK,
    content_digest: packageContentLockDigest(CANONICAL_PACKAGE_CONTENT_LOCK, files),
    bundled_required_skill_ids: ['fixture.plugin'],
    capability_provider: null,
  } as any;
  try {
    assert.equal(
      installedPackageContentLockCanonicalization(lock, root),
      CANONICAL_PACKAGE_CONTENT_LOCK,
    );
    lock.content_lock_canonicalization = LEGACY_PACKAGE_CONTENT_LOCK;
    assert.throws(
      () => installedPackageContentLockCanonicalization(lock, root),
      (error: any) => error.details?.failure_code === 'capability_package_content_digest_mismatch',
    );
    lock.content_digest = packageContentLockDigest(LEGACY_PACKAGE_CONTENT_LOCK, files);
    delete lock.content_lock_canonicalization;
    assert.equal(
      installedPackageContentLockCanonicalization(lock, root),
      LEGACY_PACKAGE_CONTENT_LOCK,
    );
    lock.content_lock_canonicalization = null;
    assert.throws(
      () => installedPackageContentLockCanonicalization(lock, root),
      (error: any) => error.details?.failure_code
        === 'capability_package_content_lock_canonicalization_invalid',
    );
  } finally {
    removeFixtureTree(root);
  }
});
test('installed content lock rejects hard-linked files before digest admission', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-content-lock-hardlink-'));
  const relativePath = 'skills/fixture.plugin/SKILL.md';
  const content = Buffer.from('# Fixture Plugin\n');
  const targetPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const externalPath = path.join(root, 'external.txt');
  fs.writeFileSync(externalPath, content);
  fs.linkSync(externalPath, targetPath);
  const lock = {
    package_id: 'fixture.plugin',
    content_lock_paths: [relativePath],
    content_lock_canonicalization: CANONICAL_PACKAGE_CONTENT_LOCK,
    content_digest: packageContentLockDigest(CANONICAL_PACKAGE_CONTENT_LOCK, [
      { path: relativePath, content },
    ]),
    bundled_required_skill_ids: ['fixture.plugin'],
    capability_provider: null,
  } as any;
  try {
    assert.equal(fs.lstatSync(targetPath).nlink, 2);
    assert.throws(
      () => installedPackageContentLockCanonicalization(lock, root),
      (error: any) => error.details?.failure_code
        === 'capability_package_content_lock_hardlink_forbidden',
    );
  } finally {
    removeFixtureTree(root);
  }
});

test('installed content lock rejects a file that changes during readback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-content-lock-race-'));
  const relativePath = 'skills/fixture.plugin/SKILL.md';
  const content = Buffer.from('# Fixture Plugin\n');
  const targetPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content);
  const lock = {
    package_id: 'fixture.plugin',
    content_lock_paths: [relativePath],
    content_lock_canonicalization: CANONICAL_PACKAGE_CONTENT_LOCK,
    content_digest: packageContentLockDigest(CANONICAL_PACKAGE_CONTENT_LOCK, [
      { path: relativePath, content },
    ]),
    bundled_required_skill_ids: ['fixture.plugin'],
    capability_provider: null,
  } as any;
  const originalFstatSync = fs.fstatSync;
  let calls = 0;
  fs.fstatSync = ((descriptor: number, ...args: unknown[]) => {
    const stat = originalFstatSync(descriptor, { bigint: true }) as fs.BigIntStats;
    calls += 1;
    if (calls === 2) {
      return { ...stat, mtimeNs: stat.mtimeNs + 1n } as unknown as fs.BigIntStats;
    }
    return stat;
  }) as typeof fs.fstatSync;
  try {
    assert.throws(
      () => installedPackageContentLockCanonicalization(lock, root),
      (error: any) => error.details?.failure_code
        === 'capability_package_content_lock_entry_changed',
    );
  } finally {
    fs.fstatSync = originalFstatSync;
    removeFixtureTree(root);
  }
});

test('developer plugin generation transaction rolls back created, replaced, reused, and symlink targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-plugin-generation-transaction-'));
  const pluginSourcePath = createPluginSourceFixture({ pluginId: 'fixture.plugin' });
  const payloadFiles = [
    {
      path: '.codex-plugin/plugin.json',
      content: Buffer.from(formatJsonPayload({ name: 'fixture.plugin', version: '0.1.0' })),
      mode: '100644' as const,
    },
    {
      path: 'skills/fixture.plugin/SKILL.md',
      content: Buffer.from('# Fixture Plugin\n'),
      mode: '100755' as const,
    },
  ];
  const manifest = {
    ...agentPackageManifest({
      packageId: 'fixture.plugin',
      agentId: 'fixture.plugin',
      pluginId: 'fixture.plugin',
      pluginSourcePath,
      distributionPayload: null,
    }),
    version: '0.1.0',
    codex_default_exposure: false,
    codex_visible_entry: 'fixture.plugin',
    required_skill_ids: ['fixture.plugin'],
    optional_skill_refs: [],
    plugin_id: 'fixture.plugin',
    plugin_source_path: pluginSourcePath,
    plugin_payload_manifest_url: null,
    plugin_payload_manifest_sha256: null,
    plugin_payload_cache_path: null,
    profile_surface: null,
    managed_policy_surface: null,
    capability_provider: null,
    content_lock_paths: [],
    developer_checkout_source: {
      surface_kind: 'opl_agent_package_developer_checkout_source.v1',
      checkout_path: pluginSourcePath,
      owner_manifest_path: path.join(pluginSourcePath, 'package.json'),
      owner_manifest_sha256: 'sha256:fixture',
      plugin_source_path: pluginSourcePath,
      source_git_head_sha: null,
      tree_sha256: 'fixture',
      payload_digest: developerCheckoutPayloadDigest(payloadFiles),
      declared_content_digest: null,
      copy_paths: payloadFiles.map((entry) => entry.path),
      copy_file_modes: Object.fromEntries(payloadFiles.map((entry) => [entry.path, entry.mode])),
    },
  } as any;
  const targetPath = path.join(root, 'cache', 'fixture.plugin', '0.1.0-dev');
  try {
    fs.mkdirSync(targetPath, { recursive: true, mode: 0o711 });
    fs.writeFileSync(path.join(targetPath, 'old.txt'), 'old bytes\n', { mode: 0o600 });
    fs.chmodSync(targetPath, 0o711);
    const oldInventory = exactTreeInventory(targetPath);
    const replaced = materializeImmutablePluginCacheTransaction({
      manifest,
      sourcePath: pluginSourcePath,
      targetPath,
      developerCheckoutPayloadFiles: payloadFiles,
      transactionId: 'replace-transaction',
    });
    assert.equal(replaced.ownership, 'replaced');
    assert.equal(fs.existsSync(path.join(targetPath, 'old.txt')), false);
    assert.equal(path.basename(replaced.displaced_path!), `${path.basename(targetPath)}.displaced-replace-transaction`);
    restorePluginGenerationMutation(replaced);
    assert.deepEqual(exactTreeInventory(targetPath), oldInventory);

    removeFixtureTree(targetPath);
    const created = materializeImmutablePluginCacheTransaction({
      manifest,
      sourcePath: pluginSourcePath,
      targetPath,
      developerCheckoutPayloadFiles: payloadFiles,
      transactionId: 'create-transaction',
    });
    assert.equal(created.ownership, 'created');
    restorePluginGenerationMutation(created);
    assert.equal(fs.existsSync(targetPath), false);

    const committed = materializeImmutablePluginCacheTransaction({
      manifest,
      sourcePath: pluginSourcePath,
      targetPath,
      developerCheckoutPayloadFiles: payloadFiles,
      transactionId: 'commit-transaction',
    });
    finalizePluginGenerationMutation(committed);
    const reused = materializeImmutablePluginCacheTransaction({
      manifest,
      sourcePath: pluginSourcePath,
      targetPath,
      developerCheckoutPayloadFiles: payloadFiles,
      transactionId: 'reuse-transaction',
    });
    assert.equal(reused.ownership, 'reused');
    restorePluginGenerationMutation(reused);
    assert.equal(fs.existsSync(targetPath), true);

    removeFixtureTree(targetPath);
    const externalTarget = path.join(root, 'external-target');
    fs.mkdirSync(externalTarget, { recursive: true, mode: 0o750 });
    fs.writeFileSync(path.join(externalTarget, 'external.txt'), 'external bytes\n', { mode: 0o640 });
    const externalMode = fs.lstatSync(externalTarget).mode & 0o777;
    const externalFileMode = fs.lstatSync(path.join(externalTarget, 'external.txt')).mode & 0o777;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.symlinkSync(externalTarget, targetPath);
    const replacedLink = materializeImmutablePluginCacheTransaction({
      manifest,
      sourcePath: pluginSourcePath,
      targetPath,
      developerCheckoutPayloadFiles: payloadFiles,
      transactionId: 'symlink-transaction',
    });
    restorePluginGenerationMutation(replacedLink);
    assert.equal(fs.lstatSync(targetPath).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(targetPath), externalTarget);
    assert.equal(fs.readFileSync(path.join(externalTarget, 'external.txt'), 'utf8'), 'external bytes\n');
    assert.equal(fs.lstatSync(externalTarget).mode & 0o777, externalMode);
    assert.equal(fs.lstatSync(path.join(externalTarget, 'external.txt')).mode & 0o777, externalFileMode);
  } finally {
    removeFixtureTree(root);
    removeFixtureTree(pluginSourcePath);
  }
});

function bindMasWorkspace(workspace: string, env: Record<string, string>) {
  fs.mkdirSync(workspace, { recursive: true });
  runCli([
    'workspace', 'bind', '--project', 'medautoscience', '--path', workspace,
  ], env);
}

function runGit(checkoutPath: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: checkoutPath, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function exactTreeInventory(root: string) {
  const inventory: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      const stat = fs.lstatSync(absolutePath);
      const kind = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file';
      const content = entry.isDirectory()
        ? ''
        : entry.isSymbolicLink()
          ? fs.readlinkSync(absolutePath)
          : crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
      inventory.push(`${kind}\0${relativePath}\0${stat.mode & 0o777}\0${content}`);
      if (entry.isDirectory()) visit(absolutePath);
    }
  };
  visit(root);
  return inventory;
}

function exactTreeDigest(root: string) {
  return crypto.createHash('sha256').update(exactTreeInventory(root).join('\n')).digest('hex');
}

function writeMasPackageRuntimeFixture(root: string, version: string) {
  fs.writeFileSync(path.join(root, 'pyproject.toml'), [
    '[build-system]',
    'requires = ["setuptools>=69"]',
    'build-backend = "setuptools.build_meta"',
    '',
    '[project]',
    'name = "med-autoscience"',
    `version = "${version}"`,
    'requires-python = ">=3.12"',
    '',
    '[project.scripts]',
    'mas-foundry-owner-gate = "med_autoscience.authority_handlers.foundry_owner_gate:main"',
    '',
    '[tool.setuptools.packages.find]',
    'where = ["src"]',
    'include = ["med_autoscience*"]',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'README.md'), `# MAS ${version}\n`);
  const packageRoot = path.join(root, 'src', 'med_autoscience', 'authority_handlers');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'med_autoscience', '__init__.py'), '');
  fs.writeFileSync(path.join(root, 'src', 'med_autoscience', 'authority_handlers', '__init__.py'), '');
  fs.writeFileSync(
    path.join(packageRoot, 'foundry_owner_gate.py'),
    'def main():\n    raise SystemExit(0)\n',
  );
}

function writeFakeMasUv(binRoot: string, fail = false, preserveReadonlyCopyModes = false) {
  fs.mkdirSync(binRoot, { recursive: true });
  if (preserveReadonlyCopyModes) {
    fs.writeFileSync(path.join(binRoot, 'cp'), [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const { spawnSync } = require('node:child_process');",
      'const args = process.argv.slice(2);',
      "const copied = spawnSync('/bin/cp', args, { stdio: 'inherit' });",
      'if (copied.status !== 0) process.exit(copied.status ?? 1);',
      "if (args[0] !== '-R') process.exit(0);",
      'const sourceRoot = path.resolve(args[1]);',
      'const targetRoot = path.resolve(args.at(-1));',
      'if ((fs.statSync(sourceRoot).mode & 0o222) !== 0) process.exit(0);',
      'const freeze = (target) => {',
      '  const stat = fs.lstatSync(target);',
      '  if (stat.isSymbolicLink()) return;',
      '  if (stat.isDirectory()) for (const entry of fs.readdirSync(target)) freeze(path.join(target, entry));',
      '  fs.chmodSync(target, stat.mode & ~0o222);',
      '};',
      'freeze(targetRoot);',
    ].join('\n'), { mode: 0o755 });
  }
  fs.writeFileSync(path.join(binRoot, 'uv'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const args = process.argv.slice(2);',
    "if (args[0] !== 'tool' || args[1] !== 'install' || !process.env.UV_TOOL_DIR) { console.error('invalid fake uv invocation'); process.exit(72); }",
    ...(fail ? ['process.exit(73);'] : [
      'const sourceRoot = args.at(-1);',
      "for (const ref of ['pyproject.toml', 'README.md', 'src/med_autoscience/authority_handlers/foundry_owner_gate.py']) {",
      "  if (!fs.existsSync(path.join(sourceRoot, ref)) || !fs.statSync(path.join(sourceRoot, ref)).isFile()) { console.error(`missing copied MAS input: ${ref}`); process.exit(74); }",
      '}',
      "fs.writeFileSync(path.join(sourceRoot, 'src/med_autoscience/authority_handlers/uv-install-probe.txt'), 'writable preparation source\\n');",
      "const target = path.join(process.env.UV_TOOL_DIR, 'med-autoscience', 'bin', 'mas-foundry-owner-gate');",
      'fs.mkdirSync(path.dirname(target), { recursive: true });',
      "fs.writeFileSync(target, '#!/usr/bin/env bash\\nif [[ \"${1:-}\" == \"--help\" ]]; then printf \"MAS OwnerGate verifier\\\\n\"; exit 0; fi\\nexit 64\\n', { mode: 0o755 });",
    ]),
  ].join('\n'), { mode: 0o755 });
}

function writeOrdinaryUserMasRelease(root: string, version: string) {
  const provider = writeCapabilityProvider(path.join(root, 'provider'), version);
  const masRoot = path.join(root, 'mas');
  const mas = writeMasConsumer(masRoot, provider, version, {
    runtimeSourceCarrier: true,
    configuredCarrier: false,
  });
  writeMasPackageRuntimeFixture(masRoot, version);
  const runtimeFiles = [
    'contracts/action_catalog.json',
    'contracts/domain_handler_registry.json',
    'contracts/pack_compiler_input.json',
    'agent/stages/manifest.json',
  ];
  for (const relativePath of runtimeFiles) {
    const targetPath = path.join(masRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, formatJsonPayload({ fixture_version: version }));
  }
  const primarySkillPath = path.join(masRoot, 'agent', 'primary_skill', 'SKILL.md');
  fs.mkdirSync(path.dirname(primarySkillPath), { recursive: true });
  fs.writeFileSync(primarySkillPath, `# MAS ${version}\n`);
  const release = writeCapabilityCatalog(path.join(root, 'release-set'), [mas, provider]);
  writeFakeMasUv(release.env.PATH.split(path.delimiter)[0]!);
  return release;
}

test('ordinary first-party repair cannot create an immutable legacy closure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-native-repair-required-'));
  const stateDir = path.join(root, 'state');
  const release = writeOrdinaryUserMasRelease(path.join(root, 'release'), '0.1.0');
  try {
    const failure = runCliFailure(['packages', 'repair', 'mas'], {
      HOME: path.join(root, 'home'),
      CODEX_HOME: path.join(root, 'home', '.codex'),
      OPL_STATE_DIR: stateDir,
      OPL_MODULE_SOURCE_MODE: 'package_channel',
      ...release.env,
    });
    assert.equal(
      failure.payload.error.details.failure_code,
      'configured_codex_plugin_carrier_owner_descriptor_missing',
    );
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-runtime-transactions')), false);
  } finally {
    removeFixtureTree(root);
  }
});

function writeStandardAgentPackProbeFixture(root: string, version: string) {
  for (const relativePath of [
    'contracts/action_catalog.json',
    'contracts/domain_descriptor.json',
    'contracts/pack_compiler_input.json',
    'agent/stages/manifest.json',
  ]) {
    const targetPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, formatJsonPayload({ fixture_version: version }));
  }
  const skillPath = path.join(root, 'agent', 'primary_skill', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, `# Standard Agent ${version}\n`);
}

function writeFoundryAgentPackProbeFixture(root: string, version: string) {
  writeStandardAgentPackProbeFixture(root, version);
  fs.writeFileSync(
    path.join(root, 'contracts', 'foundry_provider.json'),
    formatJsonPayload({ fixture_version: version }),
  );
}

test('MAS developer snapshot reuses its physical OwnerGate preparation and preserves it when a new snapshot fails', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-mas-developer-runtime-state-'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-mas-developer-runtime-source-'));
  const checkoutPath = path.join(fixtureRoot, 'med-autoscience');
  const binRoot = path.join(fixtureRoot, 'bin');
  const previousStateDir = process.env.OPL_STATE_DIR;
  const previousPath = process.env.PATH;
  fs.mkdirSync(checkoutPath, { recursive: true });
  writeMasPackageRuntimeFixture(checkoutPath, '0.1.0');
  for (const relativePath of [
    'contracts/action_catalog.json',
    'contracts/domain_handler_registry.json',
    'contracts/pack_compiler_input.json',
    'agent/stages/manifest.json',
  ]) {
    const targetPath = path.join(checkoutPath, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, '{}\n');
  }
  const primarySkillPath = path.join(checkoutPath, 'agent', 'primary_skill', 'SKILL.md');
  fs.mkdirSync(path.dirname(primarySkillPath), { recursive: true });
  fs.writeFileSync(primarySkillPath, '# MAS\n');
  runGit(checkoutPath, ['init', '-q']);
  runGit(checkoutPath, ['config', 'user.email', 'fixture@example.com']);
  runGit(checkoutPath, ['config', 'user.name', 'Fixture']);
  runGit(checkoutPath, ['add', '.']);
  runGit(checkoutPath, ['commit', '-qm', 'MAS developer runtime v1']);
  writeFakeMasUv(binRoot, false, true);
  process.env.OPL_STATE_DIR = stateDir;
  process.env.PATH = `${binRoot}${path.delimiter}${previousPath ?? ''}`;

  try {
    const carrier = {
      carrier_kind: 'opl_managed_module_source' as const,
      module_id: 'medautoscience',
    };
    const installed = applyManagedRuntimeSourceCarrier({
      config: carrier,
      previous: null,
      action: 'install',
      dryRun: false,
      packageId: FIXTURE_MAS_PACKAGE_ID,
      transactionId: 'mas-developer-runtime-v1',
      sourceKind: 'developer_checkout_override',
      checkoutPath,
    });
    assert.ok(installed.after?.preparation_root);
    finalizeManagedRuntimeSourceMutation(installed);
    const installedState = structuredClone(installed.after);
    const ownerGateBin = path.join(
      installed.after.preparation_root,
      'uv-tools',
      'med-autoscience',
      'bin',
      'mas-foundry-owner-gate',
    );
    const ownerGateStat = fs.lstatSync(ownerGateBin);
    assert.equal(ownerGateStat.isFile(), true);
    assert.equal(ownerGateStat.isSymbolicLink(), false);
    assert.notEqual(ownerGateStat.mode & 0o111, 0);

    const copiedPackageSource = path.join(
      installed.after.preparation_root,
      'uv-tools',
      'package-source',
      'src',
      'med_autoscience',
      'authority_handlers',
      'foundry_owner_gate.py',
    );
    assert.notEqual(fs.statSync(copiedPackageSource).mode & 0o222, 0);
    assert.equal(
      fs.readFileSync(
        path.join(
          installed.after.preparation_root,
          'uv-tools',
          'package-source',
          'src',
          'med_autoscience',
          'authority_handlers',
          'uv-install-probe.txt',
        ),
        'utf8',
      ),
      'writable preparation source\n',
    );
    assert.equal(
      fs.existsSync(path.join(
        installed.after.checkout_path,
        'src',
        'med_autoscience',
        'authority_handlers',
        'uv-install-probe.txt',
      )),
      false,
    );
    const repaired = applyManagedRuntimeSourceCarrier({
      config: carrier,
      previous: installed.after,
      action: 'repair',
      dryRun: false,
      packageId: FIXTURE_MAS_PACKAGE_ID,
      transactionId: 'mas-developer-runtime-repair',
      sourceKind: 'developer_checkout_override',
      checkoutPath,
    });
    assert.equal(repaired.kind, 'none');
    assert.equal(repaired.after?.preparation_root, installed.after.preparation_root);
    assert.equal(fs.existsSync(copiedPackageSource), true);
    assert.notEqual(fs.statSync(ownerGateBin).mode & 0o111, 0);

    writeFakeMasUv(binRoot, true);
    const reused = applyManagedRuntimeSourceCarrier({
      config: carrier,
      previous: installed.after,
      action: 'update',
      dryRun: false,
      packageId: FIXTURE_MAS_PACKAGE_ID,
      transactionId: 'mas-developer-runtime-reuse',
      sourceKind: 'developer_checkout_override',
      checkoutPath,
    });
    assert.equal(reused.kind, 'none');
    assert.equal(reused.after?.checkout_path, installedState.checkout_path);
    assert.equal(reused.after?.preparation_root, installedState.preparation_root);
    assert.deepEqual(reused.after?.bootstrap_command, installedState.bootstrap_command);
    assert.equal(fs.existsSync(ownerGateBin), true);
    assert.equal(managedRuntimeSourceReadiness(reused.after).status, 'current');

    const snapshotModuleRoot = path.dirname(installedState.checkout_path);
    const preparationModuleRoot = path.dirname(installedState.preparation_root!);
    const snapshotsBeforeFailure = exactTreeInventory(snapshotModuleRoot);
    const preparationsBeforeFailure = exactTreeInventory(preparationModuleRoot);
    fs.writeFileSync(path.join(checkoutPath, 'README.md'), '# MAS 0.1.1\n');
    runGit(checkoutPath, ['add', 'README.md']);
    runGit(checkoutPath, ['commit', '-qm', 'MAS developer runtime v2']);
    assert.throws(() => applyManagedRuntimeSourceCarrier({
      config: carrier,
      previous: reused.after,
      action: 'update',
      dryRun: false,
      packageId: FIXTURE_MAS_PACKAGE_ID,
      transactionId: 'mas-developer-runtime-v2-failed',
      sourceKind: 'developer_checkout_override',
      checkoutPath,
    }), (error: any) => error?.details?.failure_code === 'agent_package_runtime_source_preparation_failed');
    assert.deepEqual(reused.after, installedState);
    assert.deepEqual(exactTreeInventory(snapshotModuleRoot), snapshotsBeforeFailure);
    assert.deepEqual(exactTreeInventory(preparationModuleRoot), preparationsBeforeFailure);
    assert.equal(fs.existsSync(ownerGateBin), true);
    assert.equal(managedRuntimeSourceReadiness(reused.after).status, 'current');
    const transactionRoot = path.join(stateDir, 'agent-package-runtime-transactions');
    assert.equal(fs.existsSync(transactionRoot) ? fs.readdirSync(transactionRoot).length : 0, 0);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    removeFixtureTree(stateDir);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('OMA developer snapshot binds package identity and stays ready through its Foundry pack probe', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-oma-developer-snapshot-'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-oma-source-'));
  const checkoutPath = path.join(fixtureRoot, 'opl-meta-agent');
  const previousStateDir = process.env.OPL_STATE_DIR;
  fs.mkdirSync(path.join(checkoutPath, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(checkoutPath, 'package.json'), formatJsonPayload({
    name: 'opl-meta-agent-fixture',
    version: '0.4.0',
  }));
  writeFoundryAgentPackProbeFixture(checkoutPath, '0.4.0');
  fs.writeFileSync(path.join(checkoutPath, 'scripts', 'verify.sh'), [
    '#!/bin/sh',
    'test -d .git',
    'exit 97',
  ].join('\n'), { mode: 0o755 });
  runGit(checkoutPath, ['init', '-q']);
  runGit(checkoutPath, ['config', 'user.email', 'fixture@example.com']);
  runGit(checkoutPath, ['config', 'user.name', 'Fixture']);
  runGit(checkoutPath, ['add', '.']);
  runGit(checkoutPath, ['commit', '-qm', 'OMA 0.4.0 fixture']);
  const expectedIdentity = readDeveloperCheckoutSourceIdentity(checkoutPath);
  process.env.OPL_STATE_DIR = stateDir;

  try {
    fs.writeFileSync(path.join(checkoutPath, 'runtime-drift.txt'), 'newer source moment\n');
    assert.throws(() => applyManagedRuntimeSourceCarrier({
      config: { carrier_kind: 'opl_managed_module_source', module_id: 'oplmetaagent' },
      previous: null,
      action: 'install',
      dryRun: false,
      packageId: 'oma',
      transactionId: 'oma-identity-mismatch',
      sourceKind: 'developer_checkout_override',
      checkoutPath,
      expectedDeveloperSourceIdentity: expectedIdentity,
    }), (error: any) =>
      error?.details?.failure_code === 'agent_package_runtime_source_carrier_invalid'
      && error?.details?.expected_tree_sha256 === expectedIdentity.tree_sha256
      && error?.details?.actual_tree_sha256 !== expectedIdentity.tree_sha256);
    fs.rmSync(path.join(checkoutPath, 'runtime-drift.txt'));

    const installed = applyManagedRuntimeSourceCarrier({
      config: { carrier_kind: 'opl_managed_module_source', module_id: 'oplmetaagent' },
      previous: null,
      action: 'install',
      dryRun: false,
      packageId: 'oma',
      transactionId: 'oma-foundry-snapshot',
      sourceKind: 'developer_checkout_override',
      checkoutPath,
      expectedDeveloperSourceIdentity: expectedIdentity,
    });
    assert.ok(installed.after);
    assert.equal(installed.after.preparation_scope, 'developer_snapshot_root');
    assert.equal(fs.existsSync(path.join(installed.after.checkout_path, '.git')), false);
    const readiness = managedRuntimeSourceReadiness(installed.after);
    assert.equal(readiness.status, 'current');
    assert.equal(readiness.operational_ready, true);
    rollbackManagedRuntimeSourceMutation(installed);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    removeFixtureTree(stateDir);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('developer checkout source switch does not validate a displaced managed carrier', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-developer-source-switch-state-'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-developer-source-switch-'));
  const previousStateDir = process.env.OPL_STATE_DIR;
  const developerCheckout = path.join(fixtureRoot, 'med-autogrant');
  const displacedCheckout = path.join(fixtureRoot, 'managed-med-autogrant');
  fs.mkdirSync(path.join(developerCheckout, 'scripts'), { recursive: true });
  fs.mkdirSync(displacedCheckout, { recursive: true });
  fs.writeFileSync(path.join(developerCheckout, 'package.json'), formatJsonPayload({
    name: 'med-autogrant-fixture',
  }));
  fs.writeFileSync(path.join(developerCheckout, 'scripts', 'opl-module-healthcheck.sh'), [
    '#!/bin/sh',
    'set -eu',
    'printf "healthy\\n"',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(developerCheckout, 'scripts', 'run-python-clean.sh'), [
    '#!/bin/sh',
    'set -eu',
    'test "$1" = "-m"',
    'test "$3" = "--help"',
    'printf "ready\\n"',
  ].join('\n'), { mode: 0o755 });
  runGit(developerCheckout, ['init', '-q']);
  runGit(developerCheckout, ['config', 'user.email', 'fixture@example.com']);
  runGit(developerCheckout, ['config', 'user.name', 'Fixture']);
  runGit(developerCheckout, ['add', '.']);
  runGit(developerCheckout, ['commit', '-qm', 'developer checkout']);
  const previous = {
    surface_kind: 'opl_agent_package_managed_runtime_source' as const,
    status: 'current' as const,
    carrier_kind: 'opl_managed_module_source' as const,
    module_id: 'medautogrant',
    checkout_path: displacedCheckout,
    ownership: 'package_created' as const,
    source_mode: 'package_channel' as const,
    channel_version: '0.1.0',
    artifact_ref: 'ghcr.io/fixture/mas:0.1.0@sha256:deadbeef',
    layer_digest: `sha256:${'1'.repeat(64)}`,
    source_archive_sha256: '2'.repeat(64),
    source_git_head_sha: '3'.repeat(40),
    tree_sha256: '4'.repeat(64),
    preparation_status: 'completed' as const,
    bootstrap_command: null,
    package_prepare_command: null,
    health_check_command: ['/bin/false'],
    handler_probe_command: ['/bin/false'],
    preparation_root: null,
    preparation_scope: 'managed_source_root' as const,
  };

  try {
    process.env.OPL_STATE_DIR = stateDir;
    const preview = applyManagedRuntimeSourceCarrier({
      config: {
        carrier_kind: 'opl_managed_module_source',
        module_id: 'medautogrant',
      },
      previous,
      action: 'install',
      dryRun: true,
      packageId: FIXTURE_MAG_PACKAGE_ID,
      sourceKind: 'developer_checkout_override',
      checkoutPath: developerCheckout,
    });
    assert.equal(preview.before, previous);
    assert.equal(preview.after?.checkout_path, developerCheckout);
    assert.equal(preview.after?.source_mode, 'developer_checkout');
    assert.equal(preview.after?.status, 'validated_no_write');
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('interrupted developer snapshot activation removes only the uncommitted snapshot', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-developer-snapshot-recovery-'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-developer-snapshot-source-'));
  const checkoutPath = path.join(fixtureRoot, 'med-autogrant');
  const previousStateDir = process.env.OPL_STATE_DIR;
  fs.mkdirSync(path.join(checkoutPath, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(checkoutPath, 'runtime.txt'), 'runtime v1\n');
  writeStandardAgentPackProbeFixture(checkoutPath, 'v1');
  fs.writeFileSync(path.join(checkoutPath, 'scripts', 'opl-module-healthcheck.sh'), [
    '#!/bin/sh',
    'set -eu',
    'printf "healthy\\n"',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(checkoutPath, 'scripts', 'run-python-clean.sh'), [
    '#!/bin/sh',
    'set -eu',
    'test "$1" = "-m"',
    'test "$3" = "--help"',
    'printf "ready\\n"',
  ].join('\n'), { mode: 0o755 });
  runGit(checkoutPath, ['init', '-q']);
  runGit(checkoutPath, ['config', 'user.email', 'fixture@example.com']);
  runGit(checkoutPath, ['config', 'user.name', 'Fixture']);
  runGit(checkoutPath, ['add', '.']);
  runGit(checkoutPath, ['commit', '-qm', 'runtime v1']);
  process.env.OPL_STATE_DIR = stateDir;

  try {
    const carrier = {
      carrier_kind: 'opl_managed_module_source' as const,
      module_id: 'medautogrant',
    };
    const installed = applyManagedRuntimeSourceCarrier({
      config: carrier,
      previous: null,
      action: 'install',
      dryRun: false,
      packageId: FIXTURE_MAG_PACKAGE_ID,
      transactionId: 'developer-snapshot-v1',
      sourceKind: 'developer_checkout_override',
      checkoutPath,
    });
    assert.ok(installed.after);
    finalizeManagedRuntimeSourceMutation(installed);
    const lkgSnapshotPath = installed.after.checkout_path;
    assert.equal(fs.existsSync(lkgSnapshotPath), true);

    fs.writeFileSync(path.join(checkoutPath, 'runtime.txt'), 'runtime v2\n');
    const interrupted = applyManagedRuntimeSourceCarrier({
      config: carrier,
      previous: installed.after,
      action: 'update',
      dryRun: false,
      packageId: FIXTURE_MAG_PACKAGE_ID,
      transactionId: 'developer-snapshot-v2',
      sourceKind: 'developer_checkout_override',
      checkoutPath,
    });
    assert.ok(interrupted.after);
    const uncommittedSnapshotPath = interrupted.after.checkout_path;
    assert.notEqual(uncommittedSnapshotPath, lkgSnapshotPath);
    assert.equal(fs.existsSync(uncommittedSnapshotPath), true);
    assert.equal(fs.existsSync(interrupted.marker_path!), true);
    const preparedMarker = JSON.parse(fs.readFileSync(interrupted.marker_path!, 'utf8'));
    preparedMarker.phase = 'prepared';
    preparedMarker.mutation.after = null;
    fs.writeFileSync(interrupted.marker_path!, formatJsonPayload(preparedMarker));

    const recovery = recoverManagedRuntimeSourceTransactions({
      surface_kind: 'opl_agent_package_lock_index',
      packages: [{
        package_id: FIXTURE_MAG_PACKAGE_ID,
        managed_runtime_source: installed.after,
      }],
    } as any);
    assert.equal(recovery.status, 'recovered');
    assert.equal(recovery.recovered_transaction_count, 1);
    assert.equal(fs.existsSync(uncommittedSnapshotPath), false);
    assert.equal(fs.existsSync(lkgSnapshotPath), true);
    assert.equal(fs.existsSync(interrupted.marker_path!), false);

    fs.writeFileSync(path.join(checkoutPath, 'runtime.txt'), 'runtime v3\n');
    const physicalApplied = applyManagedRuntimeSourceCarrier({
      config: carrier,
      previous: installed.after,
      action: 'update',
      dryRun: false,
      packageId: FIXTURE_MAG_PACKAGE_ID,
      transactionId: 'developer-snapshot-v3',
      sourceKind: 'developer_checkout_override',
      checkoutPath,
    });
    assert.ok(physicalApplied.after);
    const physicalAppliedPath = physicalApplied.after.checkout_path;
    const pathMismatchedLock = {
      ...physicalApplied.after,
      checkout_path: lkgSnapshotPath,
    };
    const physicalRecovery = recoverManagedRuntimeSourceTransactions({
      surface_kind: 'opl_agent_package_lock_index',
      packages: [{
        package_id: FIXTURE_MAG_PACKAGE_ID,
        managed_runtime_source: pathMismatchedLock,
      }],
    } as any);
    assert.equal(physicalRecovery.recovered_transaction_count, 1);
    assert.equal(fs.existsSync(physicalAppliedPath), false);
    assert.equal(fs.existsSync(lkgSnapshotPath), true);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    removeFixtureTree(stateDir);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('bundled Full runtime source requires a matching carrier marker and rejects public injection', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-bundled-source-state-'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-bundled-source-fixture-'));
  const pluginSourcePath = createPluginSourceFixture();
  const bundledRoot = path.join(fixtureRoot, 'full-runtime', 'modules', 'redcube-ai');
  const unmanagedRoot = path.join(fixtureRoot, 'unmarked-redcube-ai');
  const symlinkRoot = path.join(fixtureRoot, 'linked-redcube-ai');
  const manifestPath = path.join(fixtureRoot, 'manifest.json');
  fs.mkdirSync(bundledRoot, { recursive: true });
  fs.mkdirSync(unmanagedRoot, { recursive: true });
  fs.symlinkSync(bundledRoot, symlinkRoot, 'dir');
  fs.writeFileSync(path.join(bundledRoot, 'runtime.txt'), 'immutable bundled source\n');
  fs.mkdirSync(path.join(bundledRoot, 'scripts'));
  fs.writeFileSync(path.join(bundledRoot, 'scripts', 'opl-module-healthcheck.sh'), [
    '#!/bin/sh',
    'set -eu',
    'printf "development health checks must not run for bundled Full runtimes\\n" >&2',
    'exit 91',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(unmanagedRoot, 'runtime.txt'), 'unmarked source\n');
  writeStandardAgentPackProbeFixture(bundledRoot, '0.1.0');
  fs.writeFileSync(path.join(bundledRoot, 'opl-runtime-module.json'), formatJsonPayload({
    marker_version: 1,
    module_id: 'redcube',
    repo_name: 'redcube-ai',
    packaged_runtime: true,
    source_git: { head_sha: 'b'.repeat(40) },
  }));
  fs.writeFileSync(manifestPath, formatJsonPayload({
    ...agentPackageManifest({ packageId: FIXTURE_RCA_PACKAGE_ID, agentId: 'rca', pluginSourcePath }),
    runtime_source_carrier: {
      carrier_kind: 'opl_managed_module_source',
      module_id: 'redcube',
    },
  }));
  const env = {
    OPL_STATE_DIR: stateDir,
    OPL_MODULES_ROOT: path.join(stateDir, 'managed-modules'),
  };

  try {
    const carrierInput = {
      config: {
        carrier_kind: 'opl_managed_module_source' as const,
        module_id: 'redcube',
      },
      previous: null,
      action: 'install' as const,
      dryRun: false,
      packageId: FIXTURE_RCA_PACKAGE_ID,
      sourceKind: 'bundled_full_runtime_modules' as const,
      verifiedCarrierSourceCommit: 'a'.repeat(40),
    };
    assert.throws(
      () => applyManagedRuntimeSourceCarrier({ ...carrierInput, checkoutPath: unmanagedRoot }),
      (error: any) => error?.details?.failure_code === 'agent_package_runtime_source_carrier_invalid',
    );
    assert.throws(
      () => applyManagedRuntimeSourceCarrier({
        ...carrierInput,
        checkoutPath: unmanagedRoot,
        dryRun: true,
      }),
      (error: any) => error?.details?.failure_code === 'agent_package_runtime_source_carrier_invalid',
    );
    assert.throws(
      () => applyManagedRuntimeSourceCarrier({
        ...carrierInput,
        checkoutPath: symlinkRoot,
        dryRun: true,
      }),
      (error: any) => error?.details?.failure_code === 'agent_package_runtime_source_carrier_invalid',
    );
    assert.throws(
      () => applyManagedRuntimeSourceCarrier({ ...carrierInput, checkoutPath: bundledRoot }),
      (error: any) => error?.details?.actual_owner_source_commit === 'b'.repeat(40),
    );

    fs.writeFileSync(path.join(bundledRoot, 'opl-runtime-module.json'), formatJsonPayload({
      marker_version: 1,
      module_id: 'redcube',
      repo_name: 'redcube-ai',
      packaged_runtime: true,
      package_channel: true,
      source_git: { head_sha: 'a'.repeat(40) },
      package_channel_lifecycle: { stale: true },
    }));
    assert.throws(
      () => applyManagedRuntimeSourceCarrier({
        ...carrierInput,
        checkoutPath: bundledRoot,
        verifiedCarrierSourceCommit: null,
      }),
      (error: any) => error?.details?.failure_code === 'agent_package_runtime_source_carrier_invalid',
    );
    const preview = applyManagedRuntimeSourceCarrier({
      ...carrierInput,
      checkoutPath: bundledRoot,
      dryRun: true,
    });
    assert.equal(preview.after?.status, 'validated_no_write');
    assert.equal(preview.after?.source_mode, 'bundled_full_runtime');
    assert.equal(preview.after?.channel_version, null);
    const adopted = applyManagedRuntimeSourceCarrier({ ...carrierInput, checkoutPath: bundledRoot });
    assert.equal(adopted.after?.source_git_head_sha, 'a'.repeat(40));
    assert.equal(adopted.after?.source_mode, 'bundled_full_runtime');
    assert.equal(adopted.after?.channel_version, null);
    const ready = managedRuntimeSourceReadiness(adopted.after);
    assert.equal(ready.status, 'current');
    assert.equal(ready.operational_ready, true);

    const invalid = runCliFailure([
      'packages', 'install', '--manifest-url', manifestPath, '--trust-tier', 'first_party',
      '--source-kind', 'bundled_full_runtime_modules', '--agent-root', unmanagedRoot,
    ], env);
    assert.equal(invalid.payload.error.code, 'contract_shape_invalid');
    assert.equal(
      invalid.payload.error.details.failure_code,
      'agent_package_bundled_full_runtime_source_internal_only',
    );

    const blocked = runCliFailure([
      'packages', 'install', '--manifest-url', manifestPath, '--trust-tier', 'first_party',
      '--source-kind', 'bundled_full_runtime_modules', '--agent-root', bundledRoot,
    ], env);
    assert.equal(blocked.payload.error.details.failure_code, 'agent_package_bundled_full_runtime_source_internal_only');

    fs.writeFileSync(path.join(bundledRoot, 'runtime.txt'), 'drifted bundled source\n');
    const drifted = managedRuntimeSourceReadiness(adopted.after);
    assert.equal(drifted.status, 'incompatible');
    assert.equal(drifted.operational_ready, false);
    assert.equal(
      drifted.reason,
      'managed_runtime_source_identity_mismatch',
    );
  } finally {
    removeFixtureTree(stateDir);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(pluginSourcePath, { recursive: true, force: true });
  }
});

test('ordinary first-party install cannot create legacy runtime generations without a native owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-native-generation-required-'));
  const stateDir = path.join(root, 'state');
  const modulesRoot = path.join(root, 'modules');
  const release = writeOrdinaryUserMasRelease(path.join(root, 'release'), '0.1.0');
  try {
    const failure = runCliFailure(['packages', 'install', 'mas'], {
      HOME: path.join(root, 'home'),
      CODEX_HOME: path.join(root, 'home', '.codex'),
      OPL_STATE_DIR: stateDir,
      OPL_MODULES_ROOT: modulesRoot,
      OPL_MODULE_SOURCE_MODE: 'package_channel',
      ...release.env,
    });
    assert.equal(
      failure.payload.error.details.failure_code,
      'configured_codex_plugin_carrier_owner_descriptor_missing',
    );
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(modulesRoot), false);
  } finally {
    removeFixtureTree(root);
  }
});

test('new managed runtime generation refuses a symlinked generation ancestor', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-runtime-generation-state-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-runtime-generation-outside-'));
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = stateDir;
  fs.symlinkSync(outsideRoot, path.join(stateDir, 'agent-package-runtime-generations'), 'dir');
  try {
    assert.throws(() => applyManagedRuntimeSourceCarrier({
      config: { carrier_kind: 'opl_managed_module_source', module_id: 'medautoscience' },
      previous: null,
      action: 'install',
      dryRun: false,
      packageId: 'mas',
      sourceKind: 'first_party_managed_cohort',
      packageChannelSelection: {
        package_id: 'mas',
        package_version: '0.1.0',
        source_artifact_ref: 'ghcr.io/fixture/mas:0.1.0',
        artifact_digest: `sha256:${'1'.repeat(64)}`,
        artifact_status: 'published_immutable',
        package_content_digest: `sha256:${'2'.repeat(64)}`,
        owner_source_commit: '3'.repeat(40),
      },
    }), (error: any) =>
      error?.details?.failure_code === 'agent_package_runtime_source_carrier_invalid');
    assert.deepEqual(fs.readdirSync(outsideRoot), []);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    removeFixtureTree(stateDir);
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('ordinary first-party actions do not create durable runtime-source transaction markers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-no-runtime-transactions-'));
  const stateDir = path.join(root, 'state');
  const release = writeOrdinaryUserMasRelease(path.join(root, 'release'), '0.1.0');
  try {
    const failure = runCliFailure(['packages', 'install', 'mas'], {
      HOME: path.join(root, 'home'),
      CODEX_HOME: path.join(root, 'home', '.codex'),
      OPL_STATE_DIR: stateDir,
      OPL_MODULE_SOURCE_MODE: 'package_channel',
      ...release.env,
    });
    assert.equal(
      failure.payload.error.details.failure_code,
      'configured_codex_plugin_carrier_owner_descriptor_missing',
    );
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-runtime-transactions')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle.sqlite')), false);
  } finally {
    removeFixtureTree(root);
  }
});
