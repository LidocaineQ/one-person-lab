import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { parseJsonText } from '../../../../../src/kernel/json-file.ts';
import { normalizePackageManifest } from '../../../../../src/modules/connect/agent-package-registry-parts/manifest-normalizers.ts';

test('all package manifest normalizers preserve typed Codex default exposure', () => {
  for (const [packageId, expected] of [
    ['mas', true],
    ['mas-scholar-skills', false],
    ['opl-flow', true],
  ] as const) {
    const manifestPath = path.resolve('contracts', 'opl-framework', 'packages', `${packageId}.json`);
    const payload = parseJsonText(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    payload.rollback_ref = `rollback-ref:${packageId}/legacy`;
    const normalized = normalizePackageManifest(payload, pathToFileURL(manifestPath).href);
    assert.equal(normalized.codex_default_exposure, expected);
    assert.equal(Object.hasOwn(normalized, 'rollback_ref'), false);

    const invalid = structuredClone(payload) as Record<string, any>;
    invalid.codex_surface.codex_default_exposure = 'workspace_only';
    assert.throws(
      () => normalizePackageManifest(invalid, pathToFileURL(manifestPath).href),
      (error: any) => error?.details?.failure_code === 'agent_package_codex_default_exposure_invalid',
    );
  }
});
