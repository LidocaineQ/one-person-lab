import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolvePackageHostIntegration } from '../../src/authority/packages/package-host-integration.ts';
import { normalizePackageManifest } from '../../src/adapters/integration/agent-package-registry-parts/manifest-normalizers.ts';
import { parseJsonText } from '../../src/kernel/json-file.ts';
import { validateJsonSchemaPayload } from '../../src/kernel/schema-registry.ts';
import { runAppContribution } from '../../src/read-models/operator/app-contribution-broker.ts';
import { buildAppUiContributionsProjection } from '../../src/read-models/operator/app-state-ui-contributions.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const manifestRef = 'contracts/opl-framework/packages/opl-fleet-agent.json';
const allowlistRef = 'contracts/opl-framework/package-payload-allowlists/opl-fleet-agent.json';
const payloadRef = 'contracts/opl-framework/packages/payloads/opl-fleet-agent-0.2.39.json';
const ownerCommit = '70f9a91ff9400efdb5a1ea5e748a3f370bf3c67a';

function readJson(relativePath: string) {
  return parseJsonText(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as Record<string, any>;
}

function assertSchema(relativePath: string, schemaId: string, payload: unknown) {
  const schema = readJson(relativePath);
  const result = validateJsonSchemaPayload({
    schemaId,
    schema,
    sourceRef: relativePath,
  }, payload);
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.errors));
}

function normalizedManifest() {
  const manifestPath = path.join(repoRoot, manifestRef);
  return normalizePackageManifest(readJson(manifestRef), pathToFileURL(manifestPath).href);
}

test('Fleet Agent owner projection is a schema-valid capability Package with one immutable payload', () => {
  const manifest = readJson(manifestRef);
  const allowlist = readJson(allowlistRef);
  const payload = readJson(payloadRef);

  assertSchema(
    'contracts/opl-framework/capability-package-manifest.schema.json',
    'opl.capability_package_manifest.fleet_agent.v1',
    manifest,
  );
  assertSchema(
    'contracts/opl-framework/package-payload-allowlist.schema.json',
    'opl.package_payload_allowlist.fleet_agent.v1',
    allowlist,
  );
  assertSchema(
    'contracts/opl-framework/package-payload-manifest-v2.schema.json',
    'opl.package_payload_manifest.fleet_agent.v2',
    payload,
  );

  assert.equal(manifest.package_id, 'opl-fleet-agent');
  assert.equal(manifest.codex_surface.plugin_id, 'opl-fleet-agent');
  assert.deepEqual(manifest.capability_abi, {
    id: 'opl-fleet-agent.capabilities',
    version: '1.0.0',
    compatibility_policy: 'same_major',
  });
  assert.equal(resolvePackageHostIntegration(manifest as any).integration_kind, 'capability_provider');

  const catalogEntry = normalizedManifest();
  assert.equal(catalogEntry.package_role, 'capability_package');
  assert.equal(catalogEntry.capability_provider?.capability_abi, 'opl-fleet-agent.capabilities');
  assert.deepEqual(catalogEntry.capability_provider?.module_export_ids, [
    'fleet.agent.telemetry.v1',
    'fleet.agent.doctor.v1',
  ]);

  assert.deepEqual(manifest.content_lock.paths, allowlist.paths);
  assert.deepEqual(payload.files.map((entry: any) => entry.path), allowlist.paths);
  assert.equal(payload.content_lock.digest, manifest.content_lock.digest);
  assert.equal(payload.source_commit, ownerCommit);
  assert.equal(manifest.codex_surface.carrier_source_commit, ownerCommit);
});

test('Fleet Agent contributions project into declarative settings slots without lifecycle actions', () => {
  const manifest = normalizedManifest();
  const projection = buildAppUiContributionsProjection({
    'opl-fleet-agent': {
      presence: { installed: true },
      capability_exposure: { status: 'visible' },
      app_contributions: manifest.app_contributions,
    },
  });

  assert.equal(projection.contribution_count, 2);
  assert.deepEqual(
    projection.slots['settings.section'].map((entry) => entry.contribution_key),
    [
      'opl-fleet-agent:fleet.agent.telemetry-settings',
      'opl-fleet-agent:fleet.agent.doctor-settings',
    ],
  );
  assert.deepEqual(
    projection.entries.map((entry) => entry.view?.data_ref),
    ['fleet.agent.telemetry.v1#local', 'fleet.agent.doctor.v1#current'],
  );
  assert.equal(projection.entries.every((entry) => entry.trust_tier === 'declarative'), true);
  assert.equal(projection.entries.every((entry) => entry.commands.length === 0), true);
});

test('Fleet Agent native-provider absence remains a successful unavailable contribution read', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-fleet-agent-framework-'));
  const adapterPath = path.join(sourceRoot, 'bin', 'opl-fleet-agent.mjs');
  const manifest = normalizedManifest();
  try {
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, `import fs from 'node:fs';
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify({
  schema_version: 'opl-package-app-contribution-response.v1',
  ok: true,
  operation: request.operation,
  ref: request.ref,
  result: {
    availability: 'unavailable',
    reason_code: 'native_provider_not_installed',
    freshness: { state: 'unavailable', last_observed_at: null, last_known: false },
    node: null,
  },
}));
`);
    const descriptor = {
      manifest,
      sourcePath: sourceRoot,
      enabled: true,
      readiness: {
        installed: true,
        physical_status: 'available',
        callability: 'callable',
      },
      carrier_readback: {
        kind: 'codex_plugin',
        identity: 'opl-fleet-agent@fixture',
        lifecycle_authority: 'codex_plugin_manager',
      },
    } as any;

    const output = runAppContribution({
      packageId: 'opl-fleet-agent',
      ref: 'fleet.agent.telemetry.v1#local',
      operation: 'read',
      input: {},
      confirmed: false,
    }, {
      descriptorDiscovery: {
        discover: () => new Map([['opl-fleet-agent', descriptor]]),
      },
    }) as any;

    assert.equal(output.opl_app_contribution.response.result.availability, 'unavailable');
    assert.equal(output.opl_app_contribution.response.result.reason_code, 'native_provider_not_installed');
    assert.equal(output.opl_app_contribution.response.result.freshness.state, 'unavailable');
    assert.equal(output.opl_app_contribution.response.result.node, null);
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});
