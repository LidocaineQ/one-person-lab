import {
  agentPackageManifest,
  assert,
  createPluginSourceFixture,
  formatJsonPayload,
  fs,
  os,
  parseJsonText,
  path,
  pathToFileURL,
  runCli,
  runCliAsync,
  runCliFailure,
  test,
  withAgentPackageServer,
  withRemotePayloadAgentPackageServer,
} from './helpers.ts';
function writeEmptyCodexPluginCarrier(binary: string) {
  fs.writeFileSync(binary, `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') !== 'plugin list --json') process.exit(2);
process.stdout.write(JSON.stringify({ installed: [], available: [] }));
`, 'utf8');
  fs.chmodSync(binary, 0o755);
}

test('ordinary remote payload manifests cannot enter the legacy materializer', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-remote-payload-state-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-remote-payload-home-'));
  const codexBinary = path.join(homeDir, 'empty-codex.mjs');
  const env = {
    OPL_STATE_DIR: stateDir,
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_CODEX_PLUGIN_BIN: codexBinary,
  };
  try {
    writeEmptyCodexPluginCarrier(codexBinary);
    await withRemotePayloadAgentPackageServer(async (baseUrl) => {
      await assert.rejects(
        () => runCliAsync([
          'packages',
          'install',
          '--registry-url',
          `${baseUrl}/registry.json`,
          '--package-id',
          'third.party.research',
        ], env),
        /agent_package_lifecycle_native_owner_required/,
      );
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle.sqlite')), false);
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('third-party package carrier stays isolated from canonical marketplace aliases', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-canonical-carrier-state-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-canonical-carrier-home-'));
  const codexHome = path.join(homeDir, '.codex');
  const pluginSourcePath = createPluginSourceFixture({ pluginId: 'redcube-ai' });
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-canonical-carrier-manifest-'));
  const manifestPath = path.join(fixtureDir, 'manifest.json');
  const configPath = path.join(codexHome, 'config.toml');
  const legacyMarketplaceIds = ['rca-local', 'opl-agent-rca-local'];

  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(configPath, [
      '[marketplaces.rca-local]',
      'source_type = "local"',
      'source = "/legacy/rca"',
      '',
      '[plugins."rca@rca-local"]',
      'enabled = true',
      '',
      '[marketplaces.opl-agent-rca-local]',
      'source_type = "local"',
      'source = "/legacy/opl-agent-rca"',
      '',
      '[plugins."redcube-ai@opl-agent-rca-local"]',
      'enabled = true',
      '',
    ].join('\n'), 'utf8');
    for (const marketplaceId of legacyMarketplaceIds) {
      for (const root of [
        path.join(stateDir, 'codex-plugin-marketplaces', marketplaceId),
        path.join(codexHome, 'plugins', 'cache', marketplaceId),
      ]) {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'legacy.txt'), 'legacy\n', 'utf8');
      }
    }
    fs.writeFileSync(manifestPath, formatJsonPayload(agentPackageManifest({
      packageId: 'third.party.redcube',
      agentId: 'third-party-redcube',
      pluginId: 'redcube-ai',
      pluginSourcePath,
      distributionPayload: null,
    })), 'utf8');

    const install = runCli([
      'packages', 'install', '--manifest-url', manifestPath, '--trust-tier', 'third_party_verified',
    ], {
      OPL_STATE_DIR: stateDir,
      HOME: homeDir,
      CODEX_HOME: codexHome,
    }) as any;
    const physical = install.opl_agent_package_install.physical_surface;
    const config = fs.readFileSync(configPath, 'utf8');

    assert.equal(physical.marketplace_id, 'opl-agent-third.party.redcube-local');
    assert.match(
      physical.codex_plugin_cache_path,
      /opl-agent-third\.party\.redcube-local\/redcube-ai\/1\.2\.3$/,
    );
    assert.match(config, /\[plugins\."redcube-ai@opl-agent-third\.party\.redcube-local"\]/);
    assert.match(config, /rca@rca-local/);
    assert.match(config, /opl-agent-rca-local/);
    assert.equal(physical.removed_paths.length, 0);
    for (const marketplaceId of legacyMarketplaceIds) {
      assert.equal(fs.existsSync(path.join(stateDir, 'codex-plugin-marketplaces', marketplaceId)), true);
      assert.equal(fs.existsSync(path.join(codexHome, 'plugins', 'cache', marketplaceId)), true);
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(pluginSourcePath, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('packages rejects local package payloads missing bundled required skills', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-missing-skill-state-'));
  const pluginSourcePath = createPluginSourceFixture({ includeRequiredSkill: false });
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-missing-skill-'));
  try {
    const manifestPath = path.join(fixtureDir, 'manifest.json');
    fs.writeFileSync(manifestPath, formatJsonPayload(agentPackageManifest({ pluginSourcePath })), 'utf8');
    const failure = runCliFailure([
      'packages',
      'install',
      '--manifest-url',
      pathToFileURL(manifestPath).href,
      '--trust-tier',
      'third_party_verified',
    ], { OPL_STATE_DIR: stateDir });

    assert.equal(failure.payload.error.code, 'contract_shape_invalid');
    assert.equal(failure.payload.error.details.failure_code, 'agent_package_required_skill_missing');
    assert.deepEqual(failure.payload.error.details.missing_required_skill_ids, ['third-party-research']);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(pluginSourcePath, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('package profile metadata remains owner-managed without Framework profile artifacts', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-profile-state-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-profile-home-'));
  const codexHome = path.join(homeDir, '.codex');
  const pluginSourcePath = createPluginSourceFixture();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-profile-manifest-'));
  const codexBinary = path.join(fixtureDir, 'empty-codex.mjs');
  const existingProfile = '# User profile\n\nKeep this local instruction.\n';
  const candidateProfile = '# Package profile\n\nUse the managed package preference.\n';
  const authoringSource = '# Authoring source\n';
  const env = {
    OPL_STATE_DIR: stateDir,
    HOME: homeDir,
    CODEX_HOME: codexHome,
    OPL_CODEX_PLUGIN_BIN: codexBinary,
  };

  try {
    fs.writeFileSync(codexBinary, `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') === 'plugin list --json') {
  process.stdout.write(JSON.stringify({ installed: [], available: [] }));
} else {
  process.exitCode = 2;
}
`);
    fs.chmodSync(codexBinary, 0o755);
    fs.mkdirSync(path.join(pluginSourcePath, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(pluginSourcePath, 'profile'), { recursive: true });
    fs.writeFileSync(path.join(pluginSourcePath, 'templates', 'AGENTS.md'), candidateProfile, 'utf8');
    fs.writeFileSync(path.join(pluginSourcePath, 'templates', 'TASTE.md'), authoringSource, 'utf8');
    fs.writeFileSync(path.join(pluginSourcePath, 'profile', 'manifest.json'), '{}\n', 'utf8');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), existingProfile, 'utf8');

    const manifestPath = path.join(fixtureDir, 'manifest.json');
    fs.writeFileSync(manifestPath, formatJsonPayload(agentPackageManifest({
      pluginSourcePath,
      profileSurface: {
        runtime_profile: { source_path: 'templates/AGENTS.md', target_id: 'user_agents_profile' },
        authoring_sources: [{ source_path: 'templates/TASTE.md', target_id: 'user_taste_source' }],
        merge_context_paths: ['profile/manifest.json', 'templates/TASTE.md'],
        existing_profile_policy: 'semantic_merge_required',
      },
    })), 'utf8');

    const install = runCli([
      'packages',
      'install',
      '--manifest-url',
      manifestPath,
      '--trust-tier',
      'third_party_verified',
    ], env) as any;
    const surface = install.opl_agent_package_install.physical_surface;
    const migration = surface.profile_migration;
    assert.equal(surface.profile_config.runtime_profile.source_path, 'templates/AGENTS.md');
    assert.equal(migration.status, 'not_requested');
    assert.equal(migration.writes_performed, false);
    assert.equal(migration.receipt_path, null);
    assert.equal(migration.merge_packet_path, null);
    assert.deepEqual(migration.mutation_actions, []);
    assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), existingProfile);
    assert.equal(fs.existsSync(path.join(codexHome, 'TASTE.md')), false);
    assert.equal(
      fs.existsSync(path.join(codexHome, 'state', 'third.party.research')),
      false,
    );
    const lockPath = path.join(stateDir, 'agent-package-locks.json');
    const lockBefore = fs.readFileSync(lockPath, 'utf8');
    assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), existingProfile);
    assert.equal(fs.existsSync(path.join(codexHome, 'TASTE.md')), false);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), lockBefore);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(pluginSourcePath, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('package enable and disable delegate installed descriptor carriers without private lifecycle state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-native-exposure-'));
  const codexHome = path.join(root, 'codex-home');
  const stateDir = path.join(root, 'opl-state');
  const pluginRoot = path.join(root, 'plugin-source');
  const binary = path.join(root, 'fake-codex');
  const env = {
    CODEX_HOME: codexHome,
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
    FIXTURE_PLUGIN_SOURCE: pluginRoot,
  };
  try {
    fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'skills', 'fixture-native-carrier'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), formatJsonPayload({
      name: 'fixture-native-carrier',
      version: '1.0.0',
      skills: './skills/',
    }), 'utf8');
    fs.writeFileSync(path.join(pluginRoot, 'skills', 'fixture-native-carrier', 'SKILL.md'), '# fixture\n', 'utf8');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model = "user-model"',
      '',
      '[plugins."fixture-native-carrier@fixture-marketplace"]',
      'enabled = true',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(binary, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const config = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
const enabled = !/\\[plugins\\."fixture-native-carrier@fixture-marketplace"\\][\\s\\S]*?enabled = false/.test(config);
if (process.argv.slice(2).join(' ') !== 'plugin list --json') process.exit(2);
process.stdout.write(JSON.stringify({ installed: [{
  pluginId: 'fixture-native-carrier@fixture-marketplace', version: '1.0.0', installed: true, enabled,
  source: { source: 'local', path: process.env.FIXTURE_PLUGIN_SOURCE },
  marketplaceSource: { sourceType: 'local', source: 'fixture-marketplace' },
}], available: [] }));
`, 'utf8');
    fs.chmodSync(binary, 0o755);

    const disabled = runCli(['packages', 'disable', 'fixture-native-carrier'], env) as any;
    const disabledResult = disabled.opl_agent_package_exposure;
    assert.equal(disabledResult.status, 'disabled');
    assert.equal(disabledResult.action, 'disable');
    assert.equal(disabledResult.package_id, 'fixture-native-carrier');
    assert.equal(Object.hasOwn(disabledResult, 'package_lock'), false);
    assert.equal(Object.hasOwn(disabledResult, 'lifecycle_receipt'), false);
    assert.equal(disabledResult.configured_carrier.enabled, false);
    assert.equal(Object.hasOwn(disabledResult, 'opl_private_state_writes'), false);
    assert.equal(fs.existsSync(stateDir), false);

    const enabled = runCli(['packages', 'enable', 'fixture-native-carrier'], env) as any;
    const enabledResult = enabled.opl_agent_package_exposure;
    assert.equal(enabledResult.status, 'enabled');
    assert.equal(Object.hasOwn(enabledResult, 'package_lock'), false);
    assert.equal(Object.hasOwn(enabledResult, 'lifecycle_receipt'), false);
    assert.equal(enabledResult.configured_carrier.enabled, true);
    assert.equal(enabledResult.configured_carrier.executor.status, 'callable');
    assert.equal(fs.existsSync(stateDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('packages retain declared profile metadata without materializing an empty Codex home', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-fresh-profile-state-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-fresh-profile-home-'));
  const pluginSourcePath = createPluginSourceFixture();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-fresh-profile-manifest-'));
  const candidateProfile = '# Fresh package profile\n';
  try {
    fs.mkdirSync(path.join(pluginSourcePath, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(pluginSourcePath, 'templates', 'AGENTS.md'), candidateProfile, 'utf8');
    fs.writeFileSync(path.join(pluginSourcePath, 'templates', 'TASTE.md'), '# Fresh authoring source\n', 'utf8');
    const manifestPath = path.join(fixtureDir, 'manifest.json');
    fs.writeFileSync(manifestPath, formatJsonPayload(agentPackageManifest({
      pluginSourcePath,
      profileSurface: {
        runtime_profile: { source_path: 'templates/AGENTS.md', target_id: 'user_agents_profile' },
        authoring_sources: [{ source_path: 'templates/TASTE.md', target_id: 'user_taste_source' }],
        merge_context_paths: [],
        existing_profile_policy: 'semantic_merge_required',
      },
    })), 'utf8');
    const codexHome = path.join(homeDir, '.codex');
    const install = runCli([
      'packages',
      'install',
      '--manifest-url',
      manifestPath,
      '--trust-tier',
      'third_party_verified',
    ], { OPL_STATE_DIR: stateDir, HOME: homeDir, CODEX_HOME: codexHome }) as any;
    const surface = install.opl_agent_package_install.physical_surface;
    const migration = surface.profile_migration;
    assert.equal(surface.profile_config.runtime_profile.source_path, 'templates/AGENTS.md');
    assert.equal(migration.status, 'not_requested');
    assert.equal(migration.writes_performed, false);
    assert.equal(migration.receipt_path, null);
    assert.equal(migration.merge_packet_path, null);
    assert.equal(fs.existsSync(path.join(codexHome, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(codexHome, 'TASTE.md')), false);
    assert.equal(
      fs.existsSync(path.join(codexHome, 'state', 'third.party.research')),
      false,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(pluginSourcePath, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('legacy profile receipt collisions do not affect package installation after writer retirement', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-profile-failure-state-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-profile-failure-home-'));
  const pluginSourcePath = createPluginSourceFixture();
  const manifestPath = path.join(stateDir, 'profile-failure-manifest.json');
  try {
    fs.mkdirSync(path.join(pluginSourcePath, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(pluginSourcePath, 'templates', 'AGENTS.md'), '# runtime profile\n');
    fs.writeFileSync(path.join(pluginSourcePath, 'templates', 'TASTE.md'), '# authoring source\n');
    fs.mkdirSync(path.join(codexHome, 'state', 'third.party.research', 'profile-install-receipt.json'), { recursive: true });
    fs.writeFileSync(manifestPath, formatJsonPayload(agentPackageManifest({
      pluginSourcePath,
      profileSurface: {
        runtime_profile: { source_path: 'templates/AGENTS.md', target_id: 'user_agents_profile' },
        authoring_sources: [{ source_path: 'templates/TASTE.md', target_id: 'user_taste_source' }],
        merge_context_paths: [],
        existing_profile_policy: 'semantic_merge_required',
      },
    })));

    const install = runCli([
      'packages', 'install', '--manifest-url', manifestPath, '--trust-tier', 'third_party',
    ], { OPL_STATE_DIR: stateDir, CODEX_HOME: codexHome }) as any;
    const migration = install.opl_agent_package_install.physical_surface.profile_migration;
    assert.equal(install.opl_agent_package_install.status, 'installed');
    assert.equal(migration.status, 'not_requested');
    assert.equal(migration.writes_performed, false);
    assert.equal(fs.existsSync(path.join(codexHome, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(codexHome, 'TASTE.md')), false);
    assert.equal(
      fs.statSync(path.join(codexHome, 'state', 'third.party.research', 'profile-install-receipt.json')).isDirectory(),
      true,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(pluginSourcePath, { recursive: true, force: true });
  }
});

test('app action execute routes install_from_manifest_url to the Framework package lock and carrier adapter', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-app-action-state-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-app-action-home-'));
  const codexHome = path.join(homeDir, '.codex');
  const codexBinary = path.join(homeDir, 'empty-codex.mjs');
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-package-manifest-'));
  const pluginSourcePath = createPluginSourceFixture();
  const env = {
    OPL_STATE_DIR: stateDir,
    HOME: homeDir,
    CODEX_HOME: codexHome,
    OPL_CODEX_PLUGIN_BIN: codexBinary,
  };
  try {
    writeEmptyCodexPluginCarrier(codexBinary);
    const manifestPath = path.join(fixtureDir, 'manifest.json');
    fs.writeFileSync(manifestPath, formatJsonPayload(agentPackageManifest({ pluginSourcePath })), 'utf8');
    const manifestUrl = pathToFileURL(manifestPath).href;
    const missingTrustTier = runCliFailure([
      'app',
      'action',
      'execute',
      '--action',
      'install_from_manifest_url',
      '--payload',
      JSON.stringify({ manifest_url: manifestUrl }),
    ], env);
    assert.equal(missingTrustTier.payload.error.code, 'cli_usage_error');
    assert.deepEqual(missingTrustTier.payload.error.details.required, ['--trust-tier']);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
    const output = runCli([
      'app',
      'action',
      'execute',
      '--action',
      'install_from_manifest_url',
      '--payload',
      JSON.stringify({
        manifest_url: manifestUrl,
        trust_tier: 'third_party_verified',
      }),
    ], env) as {
      app_action_execution: {
        delegated_surface: string;
        result: {
          opl_agent_package_install: {
            status: string;
            package_id: string;
            package_lock: { package_id: string; source_kind: string };
          };
        };
      };
    };

    assert.equal(output.app_action_execution.delegated_surface, 'opl packages install --manifest-url <manifest_url>');
    assert.equal(output.app_action_execution.result.opl_agent_package_install.status, 'installed');
    assert.equal(output.app_action_execution.result.opl_agent_package_install.package_id, 'third.party.research');
    assert.equal(output.app_action_execution.result.opl_agent_package_install.package_lock.package_id, 'third.party.research');
    assert.equal(output.app_action_execution.result.opl_agent_package_install.package_lock.source_kind, 'local_manifest_file');
    assert.equal(
      Object.hasOwn(output.app_action_execution.result.opl_agent_package_install, 'lifecycle_receipt'),
      false,
    );

    const repair = runCli([
      'app',
      'action',
      'execute',
      '--action',
      'agent_package_repair',
      '--payload',
      JSON.stringify({ package_id: 'third.party.research' }),
    ], env) as {
      app_action_execution: {
        delegated_surface: string;
        result: {
          opl_agent_package_repair: {
            status: string;
          };
        };
      };
    };
    assert.equal(repair.app_action_execution.delegated_surface, 'opl packages repair --package-id <package_id>');
    assert.equal(repair.app_action_execution.result.opl_agent_package_repair.status, 'repaired');
    assert.equal(
      Object.hasOwn(repair.app_action_execution.result.opl_agent_package_repair, 'lifecycle_receipt'),
      false,
    );

    const lockPath = path.join(stateDir, 'agent-package-locks.json');
    const lockBeforeExposure = fs.readFileSync(lockPath, 'utf8');
    const exposurePreference = runCliFailure([
      'app',
      'action',
      'execute',
      '--action',
      'agent_package_preferences_set',
      '--payload',
      JSON.stringify({
        package_id: 'third.party.research',
        exposure_action: 'disable',
      }),
    ], env);
    assert.equal(
      exposurePreference.payload.error.details.failure_code,
      'agent_package_exposure_native_owner_required',
    );
    assert.equal(exposurePreference.payload.error.details.action, 'disable');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), lockBeforeExposure);

    const shortcutPreference = runCli([
      'app',
      'action',
      'execute',
      '--action',
      'agent_package_preferences_set',
      '--payload',
      JSON.stringify({
        package_id: 'third.party.research',
        shortcut_id: 'research',
        visible: false,
        sort_order: 9,
      }),
    ], env) as {
      app_action_execution: {
        delegated_surface: string;
        result: {
          opl_agent_package_home_shortcut_preferences: {
            status: string;
            preference: { shortcut_id: string; visible: boolean; sort_order: number };
          };
        };
      };
    };
    assert.equal(
      shortcutPreference.app_action_execution.delegated_surface,
      'opl packages preferences set --package-id <package_id> --shortcut-id <shortcut_id>',
    );
    assert.equal(shortcutPreference.app_action_execution.result.opl_agent_package_home_shortcut_preferences.status, 'preferences_updated');
    assert.equal(shortcutPreference.app_action_execution.result.opl_agent_package_home_shortcut_preferences.preference.shortcut_id, 'research');
    assert.equal(shortcutPreference.app_action_execution.result.opl_agent_package_home_shortcut_preferences.preference.visible, false);
    assert.equal(shortcutPreference.app_action_execution.result.opl_agent_package_home_shortcut_preferences.preference.sort_order, 9);
    assert.equal(
      Object.hasOwn(
        shortcutPreference.app_action_execution.result.opl_agent_package_home_shortcut_preferences,
        'lifecycle_receipt',
      ),
      false,
    );

    const list = runCli(['packages', 'list'], env) as {
      opl_agent_packages: {
        home_shortcut_preferences: Array<{ package_id: string; shortcut_id: string; visible: boolean; sort_order: number; source: string }>;
        files: { home_shortcut_preferences_file: string };
      };
    };
    assert.deepEqual(
      list.opl_agent_packages.home_shortcut_preferences
        .filter((entry) => entry.package_id === 'third.party.research')
        .map((entry) => ({
          package_id: entry.package_id,
          shortcut_id: entry.shortcut_id,
          visible: entry.visible,
          sort_order: entry.sort_order,
          source: entry.source,
        })),
      [{
      package_id: 'third.party.research',
      shortcut_id: 'research',
      visible: false,
      sort_order: 9,
      source: 'user_preference',
      }],
    );
    assert.equal(fs.existsSync(list.opl_agent_packages.files.home_shortcut_preferences_file), true);
    assert.equal(Object.hasOwn(list.opl_agent_packages.files, 'package_lock_file'), false);
    assert.equal(Object.hasOwn(list.opl_agent_packages.files, 'lifecycle_ledger_file'), false);

  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.rmSync(pluginSourcePath, { recursive: true, force: true });
  }
});
