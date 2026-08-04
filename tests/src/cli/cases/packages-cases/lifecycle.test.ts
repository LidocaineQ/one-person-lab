import {
  agentPackageManifest,
  assert,
  createPluginSourceFixture,
  fs,
  os,
  path,
  runCli,
  runCliAsync,
  test,
  withAgentPackageServer,
} from './helpers.ts';

test('explicit registry selection installs without a persistent discovery cache', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-packages-state-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-packages-home-'));
  const pluginSourcePath = createPluginSourceFixture();
  const env = {
    OPL_STATE_DIR: stateDir,
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_CLI_TEST_TIMEOUT_MS: '90000',
  };
  try {
    await withAgentPackageServer(async (baseUrl) => {
      const registryUrl = `${baseUrl}/registry.json`;
      const args = ['--registry-url', registryUrl, '--package-id', 'third.party.research'];
      const install = await runCliAsync(['packages', 'install', ...args], env) as any;
      assert.equal(install.opl_agent_package_install.status, 'installed');
      assert.equal(install.opl_agent_package_install.package_lock.package_id, 'third.party.research');
      assert.equal(Object.hasOwn(install.opl_agent_package_install, 'lifecycle_receipt'), false);
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-registry-cache.json')), false);
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), true);
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);

      const listed = await runCliAsync(['packages', 'list'], env) as any;
      assert.equal(Object.hasOwn(listed.opl_agent_packages, 'registry_cache'), false);
      assert.equal(listed.opl_agent_packages.directory.entries.some((entry: any) =>
        entry.package_id === 'third.party.research' && entry.installed === true
      ), true);

      const uninstall = await runCliAsync(['packages', 'uninstall', '--package-id', 'third.party.research'], env) as any;
      assert.equal(uninstall.opl_agent_package_uninstall.status, 'uninstalled');
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-registry-cache.json')), false);
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);
    }, agentPackageManifest({ pluginSourcePath }));
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(pluginSourcePath, { recursive: true, force: true });
  }
});
