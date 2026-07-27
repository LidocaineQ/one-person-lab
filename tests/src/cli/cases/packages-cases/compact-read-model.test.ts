import {
  agentPackageManifest,
  assert,
  createPluginSourceFixture,
  fs,
  os,
  path,
  pathToFileURL,
  runCli,
  runCliFailure,
  test,
} from './helpers.ts';
import { formatJsonPayload, parseJsonText } from '../../../../../src/kernel/json-file.ts';

test('package read models stay compact without exposing lifecycle history', (context) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-compact-read-model-state-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-compact-read-model-home-'));
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-compact-read-model-fixture-'));
  const pluginSourcePath = createPluginSourceFixture();
  const manifestPath = path.join(fixtureDir, 'manifest.json');
  const ledgerPath = path.join(stateDir, 'agent-package-lifecycle-ledger.json');
  const env = {
    OPL_STATE_DIR: stateDir,
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
  };
  try {
    fs.writeFileSync(
      manifestPath,
      formatJsonPayload(agentPackageManifest({ pluginSourcePath })),
      'utf8',
    );
    const install = runCli([
      'packages',
      'install',
      '--manifest-url',
      pathToFileURL(manifestPath).href,
      '--trust-tier',
      'third_party_verified',
    ], env) as any;
    const installedReceiptRef = install.opl_agent_package_install.package_lock.action_receipt_id;
    const ledger = parseJsonText(fs.readFileSync(ledgerPath, 'utf8')) as any;
    const receiptTemplate = ledger.receipts.find(
      (receipt: any) => receipt.receipt_ref === installedReceiptRef,
    );
    const diagnosticBody = 'x'.repeat(8_192);
    const packageHistory = Array.from({ length: 250 }, (_, index) => ({
      ...receiptTemplate,
      receipt_ref: `opl://agent-package-lifecycle/third.party.research/history-${String(index).padStart(3, '0')}`,
      recorded_at: new Date(Date.UTC(2026, 6, 24, 12, 0, 0) - index * 1_000).toISOString(),
      action: 'repair',
      package_id: 'third.party.research',
      diagnostic_body: `${index}:${diagnosticBody}`,
    }));
    const otherPackageHistory = Array.from({ length: 30 }, (_, index) => ({
      ...receiptTemplate,
      receipt_ref: `opl://agent-package-lifecycle/other.package/history-${String(index).padStart(3, '0')}`,
      recorded_at: new Date(Date.UTC(2026, 6, 23, 12, 0, 0) - index * 1_000).toISOString(),
      action: 'repair',
      package_id: 'other.package',
      diagnostic_body: `${index}:${diagnosticBody}`,
    }));
    ledger.receipts = [...packageHistory, ...otherPackageHistory, ...ledger.receipts];
    fs.writeFileSync(ledgerPath, formatJsonPayload(ledger), 'utf8');
    const ledgerBytesBeforeRead = fs.readFileSync(ledgerPath);

    const status = runCli([
      'packages',
      'status',
      '--package-id',
      'third.party.research',
    ], env) as any;
    const list = runCli(['packages', 'list'], env) as any;
    assert.equal(Object.hasOwn(status.opl_agent_package_status, 'lifecycle_receipts'), false);
    assert.equal(Object.hasOwn(status.opl_agent_package_status, 'lifecycle_history'), false);
    assert.equal(Object.hasOwn(status.opl_agent_package_status, 'lifecycle_receipt_summary'), false);
    assert.equal(Object.hasOwn(list.opl_agent_packages, 'lifecycle_receipts'), false);
    assert.equal(Object.hasOwn(list.opl_agent_packages, 'lifecycle_history'), false);
    assert.equal(Object.hasOwn(list.opl_agent_packages, 'lifecycle_receipt_count'), false);
    assert.equal(Object.hasOwn(list.opl_agent_packages, 'lifecycle_receipt_summary'), false);

    const compactStatusBytes = Buffer.byteLength(JSON.stringify(status));
    const compactListBytes = Buffer.byteLength(JSON.stringify(list));
    const legacyInlineBytes = Buffer.byteLength(JSON.stringify({
      ...status,
      opl_agent_package_status: {
        ...status.opl_agent_package_status,
        lifecycle_receipts: ledger.receipts.filter(
          (receipt: any) => receipt.package_id === 'third.party.research',
        ),
      },
    }));
    assert.ok(compactStatusBytes < 100_000, `compact status was ${compactStatusBytes} bytes`);
    assert.ok(compactListBytes < 500_000, `compact list was ${compactListBytes} bytes`);
    assert.ok(
      legacyInlineBytes > compactStatusBytes * 10,
      `legacy ${legacyInlineBytes} bytes must exceed compact ${compactStatusBytes} bytes by at least 10x`,
    );
    context.diagnostic(JSON.stringify({
      ledger_bytes: ledgerBytesBeforeRead.byteLength,
      legacy_inline_status_bytes: legacyInlineBytes,
      compact_status_bytes: compactStatusBytes,
      compact_list_bytes: compactListBytes,
      receipt_count: ledger.receipts.length,
    }));
    assert.deepEqual(fs.readFileSync(ledgerPath), ledgerBytesBeforeRead);
    for (const retiredArgs of [
      ['--include-history'],
      ['--cursor', 'retired'],
      ['--limit', '10'],
    ]) {
      const failure = runCliFailure([
        'packages',
        'status',
        ...retiredArgs,
      ], env);
      assert.equal(failure.payload.error.code, 'cli_usage_error');
      assert.match(failure.payload.error.message, new RegExp(retiredArgs[0].slice(2)));
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.rmSync(pluginSourcePath, { recursive: true, force: true });
  }
});
