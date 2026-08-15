import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrateLegacyOplDocInstall } from '../../../../../src/adapters/integration/agent-package-registry-parts/legacy-opl-doc-install-migration.ts';


function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-doc-migration-'));
  const pluginRoot = path.join(home, 'plugins', 'opl-doc');
  const doctorPath = path.join(pluginRoot, 'scripts', 'opl_doc_doctor.py');
  const skillPath = path.join(pluginRoot, 'skills', 'opl-doc', 'SKILL.md');
  const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
  const commandPath = path.join(home, '.local', 'bin', 'opl-doc-doctor');
  const marketplacePath = path.join(home, '.agents', 'plugins', 'marketplace.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.mkdirSync(path.dirname(doctorPath), { recursive: true });
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.mkdirSync(path.dirname(commandPath), { recursive: true });
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify({ name: 'opl-doc', version: '0.1.0' })}\n`);
  fs.writeFileSync(doctorPath, '#!/usr/bin/env python3\n');
  fs.writeFileSync(skillPath, '# OPL Doc\nlocal content may drift\n');
  fs.symlinkSync(doctorPath, commandPath);
  fs.writeFileSync(marketplacePath, `${JSON.stringify({
    name: 'fixture',
    plugins: [
      { name: 'keep-me', source: { source: 'local', path: './plugins/keep-me' } },
      { name: 'opl-doc', source: { source: 'local', path: './plugins/opl-doc' } },
    ],
  }, null, 2)}\n`);
  return { home, pluginRoot, doctorPath, commandPath, marketplacePath };
}

test('legacy OPL Doc migration removes only source-proven install surfaces', () => {
  const value = fixture();
  const result = migrateLegacyOplDocInstall({ env: { HOME: value.home } });

  assert.equal(result.status, 'completed');
  assert.equal(result.writes_performed, true);
  assert.deepEqual(result.after, { plugin_root: false, command: false, marketplace_entry: false });
  assert.equal(fs.existsSync(value.pluginRoot), false);
  assert.equal(fs.existsSync(value.commandPath), false);
  const marketplace = JSON.parse(fs.readFileSync(value.marketplacePath, 'utf8'));
  assert.deepEqual(marketplace.plugins.map((entry: any) => entry.name), ['keep-me']);
  assert.equal(migrateLegacyOplDocInstall({ env: { HOME: value.home } }).status, 'absent');
});

test('legacy OPL Doc migration dry-run validates identity without writing', () => {
  const value = fixture();
  fs.appendFileSync(value.doctorPath, '# locally drifted implementation\n');

  const result = migrateLegacyOplDocInstall({ dryRun: true, env: { HOME: value.home } });

  assert.equal(result.status, 'validated_no_write');
  assert.equal(result.writes_performed, false);
  assert.equal(fs.existsSync(value.pluginRoot), true);
  assert.equal(fs.lstatSync(value.commandPath).isSymbolicLink(), true);
});

test('legacy OPL Doc migration preserves ambiguous command ownership', () => {
  const value = fixture();
  fs.unlinkSync(value.commandPath);
  fs.writeFileSync(value.commandPath, '# user-owned command\n');

  const result = migrateLegacyOplDocInstall({ env: { HOME: value.home } });

  assert.equal(result.status, 'manual_required');
  assert.equal(result.failure_code, 'command_identity_mismatch');
  assert.equal(result.writes_performed, false);
  assert.equal(fs.existsSync(value.pluginRoot), true);
  assert.equal(fs.readFileSync(value.commandPath, 'utf8'), '# user-owned command\n');
});

test('legacy OPL Doc migration rejects a symlinked plugin root', () => {
  const value = fixture();
  const realRoot = `${value.pluginRoot}-real`;
  fs.renameSync(value.pluginRoot, realRoot);
  fs.symlinkSync(realRoot, value.pluginRoot);
  fs.unlinkSync(value.commandPath);
  fs.symlinkSync(path.join(realRoot, 'scripts', 'opl_doc_doctor.py'), value.commandPath);

  const result = migrateLegacyOplDocInstall({ env: { HOME: value.home } });

  assert.equal(result.status, 'manual_required');
  assert.equal(result.failure_code, 'plugin_root_not_safe_directory');
  assert.equal(result.writes_performed, false);
});

test('legacy OPL Doc migration detects marketplace compare-and-swap drift before cleanup', () => {
  const value = fixture();
  const result = migrateLegacyOplDocInstall({
    env: { HOME: value.home },
    beforeMarketplaceReplace: () => fs.appendFileSync(value.marketplacePath, '\n'),
  });

  assert.equal(result.status, 'manual_required');
  assert.equal(result.failure_code, 'marketplace_changed_before_replace');
  assert.equal(result.writes_performed, false);
  assert.equal(fs.existsSync(value.pluginRoot), true);
  assert.equal(fs.lstatSync(value.commandPath).isSymbolicLink(), true);
});
