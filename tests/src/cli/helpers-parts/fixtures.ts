import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseJsonText } from '../../../../src/kernel/json-file.ts';

import { contractsDir, familyManifestFixtureDir, repoRoot } from './constants.ts';

export function createContractsFixtureRoot(mutator?: (contractsRoot: string) => void) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-contract-fixture-'));
  const fixtureContractsRoot = path.join(fixtureRoot, 'contracts', 'opl-framework');
  fs.mkdirSync(fixtureContractsRoot, { recursive: true });
  fs.cpSync(contractsDir, fixtureContractsRoot, {
    recursive: true,
  });
  mutator?.(fixtureContractsRoot);
  return { fixtureRoot, fixtureContractsRoot };
}

export function createFakeCodexFixture(handlerBody: string) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-codex-fixture-'));
  const codexPath = path.join(fixtureRoot, 'codex');
  fs.writeFileSync(
    codexPath,
    `#!/usr/bin/env bash
set -euo pipefail
${handlerBody}
`,
    { mode: 0o755 },
  );
  return {
    fixtureRoot,
    codexPath,
  };
}

export function createFakeCodexPluginManagerFixture(
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-codex-plugin-manager-fixture-')),
) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const codexPath = path.join(fixtureRoot, 'codex');
  fs.writeFileSync(
    codexPath,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex-cli 0.134.0\\n');
  process.exit(0);
}
if (args.join(' ') !== 'plugin list --json') {
  process.exit(2);
}

const configPath = path.join(process.env.CODEX_HOME || '', 'config.toml');
const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
const sections = new Map();
let current = null;
for (const line of config.split('\\n')) {
  const header = line.trim().match(/^\\[([^\\]]+)\\]$/);
  if (header) {
    current = header[1];
    sections.set(current, []);
  } else if (current) {
    sections.get(current).push(line);
  }
}
const unquote = (value) => {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\\\"/g, '"').replace(/\\\\\\\\/g, '\\\\');
  }
  return value;
};
const stringValue = (lines, key) => {
  const pattern = new RegExp('^\\\\s*' + key + '\\\\s*=\\\\s*"((?:\\\\\\\\.|[^"\\\\\\\\])*)"\\\\s*$');
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return match[1].replace(/\\\\"/g, '"').replace(/\\\\\\\\/g, '\\\\');
  }
  return null;
};
const marketplaces = new Map();
for (const [header, lines] of sections) {
  if (!header.startsWith('marketplaces.')) continue;
  const id = unquote(header.slice('marketplaces.'.length));
  const source = stringValue(lines, 'source');
  if (id && source) marketplaces.set(id, source);
}
const installed = [];
for (const [header, lines] of sections) {
  if (!header.startsWith('plugins.')) continue;
  const selector = unquote(header.slice('plugins.'.length));
  const separator = selector.lastIndexOf('@');
  if (separator <= 0) continue;
  const pluginId = selector.slice(0, separator);
  const marketplaceId = selector.slice(separator + 1);
  const marketplaceRoot = marketplaces.get(marketplaceId);
  if (!marketplaceRoot) continue;
  const sourcePath = path.join(marketplaceRoot, 'plugins', pluginId);
  const manifestPath = path.join(sourcePath, '.codex-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); // reuse-first: allow disposable fake Codex CLI to parse its own copied plugin manifest.
  installed.push({
    pluginId: selector,
    version: typeof manifest.version === 'string' ? manifest.version : null,
    installed: true,
    enabled: !lines.some((line) => /^\\s*enabled\\s*=\\s*false\\s*$/.test(line)),
    source: { source: 'local', path: sourcePath },
    marketplaceSource: { sourceType: 'local', source: marketplaceRoot },
  });
}
process.stdout.write(JSON.stringify({ installed, available: [] }));
`,
    { mode: 0o755 },
  );
  return {
    fixtureRoot,
    codexPath,
  };
}

export function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createCodexConfigFixture(options: {
  model?: string;
  reasoningEffort?: string;
  providerId?: string;
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
} = {}) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-codex-home-'));
  const configPath = path.join(codexHome, 'config.toml');
  const model = options.model ?? 'gpt-5.4-lab';
  const reasoningEffort = options.reasoningEffort ?? 'xhigh';
  const providerId = options.providerId ?? 'lab';
  const providerName = options.providerName ?? 'lab';
  const baseUrl = options.baseUrl ?? 'https://codex-provider.example.test/v1';
  const apiKey = options.apiKey ?? 'codex-provider-key';

  fs.writeFileSync(
    configPath,
    [
      `model_provider = "${providerId}"`,
      `model = "${model}"`,
      `model_reasoning_effort = "${reasoningEffort}"`,
      '',
      `[model_providers.${providerId}]`,
      `name = "${providerName}"`,
      `base_url = "${baseUrl}"`,
      `experimental_bearer_token = "${apiKey}"`,
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    codexHome,
    configPath,
    model,
    reasoningEffort,
    providerId,
    providerName,
    baseUrl,
    apiKey,
  };
}

export function createMasWorkspaceFixture(profileName = 'nfpitnet.workspace.toml') {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-mas-workspace-'));
  const sharedPath = path.join(fixtureRoot, 'ops', 'medautoscience', 'bin', '_shared.sh');
  const profilePath = path.join(fixtureRoot, 'ops', 'medautoscience', 'profiles', profileName);

  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(sharedPath, '#!/usr/bin/env bash\nset -euo pipefail\n', {
    mode: 0o755,
  });
  fs.writeFileSync(
    profilePath,
    [
      '[workspace]',
      'workspace_id = "mas-fixture"',
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    fixtureRoot,
    sharedPath,
    profilePath,
  };
}

export function buildManifestCommand(payload: Record<string, unknown>) {
  return `${process.execPath} -e "process.stdout.write(process.argv[1])" ${shellSingleQuote(JSON.stringify(payload))}`;
}

export function readJsonFixture<T>(name: string) {
  return parseJsonText(
    fs.readFileSync(path.join(familyManifestFixtureDir, name), 'utf8'),
  ) as T;
}
