import {
  agentPackageManifest,
  assert,
  createPluginSourceFixture,
  fs,
  os,
  path,
  runCliAsync,
  test,
  withAgentPackageServer,
} from './helpers.ts';

test('ordinary remote registry selection requires a native owner before private state writes', async () => {
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
      await assert.rejects(
        () => runCliAsync(['packages', 'install', ...args], env),
        /agent_package_lifecycle_native_owner_required/,
      );
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-registry-cache.json')), false);
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle.sqlite')), false);
    }, agentPackageManifest({ pluginSourcePath }));
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(pluginSourcePath, { recursive: true, force: true });
  }
});
