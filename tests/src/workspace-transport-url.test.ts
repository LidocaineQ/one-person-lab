import assert from 'node:assert/strict';
import test from 'node:test';

import { workspaceTransportDisplayUrl } from '../../src/modules/runway/workspace-transport-url.ts';

test('workspace transport display URL removes credentials but retains ordinary query context', () => {
  assert.equal(
    workspaceTransportDisplayUrl(
      'https://fixture-user:fixture-password@example.test/private.git?ref=main&access_token=query-secret&depth=1',
    ),
    'https://example.test/private.git?ref=main&depth=1',
  );
  assert.equal(
    workspaceTransportDisplayUrl(
      'ssh://fixture-user:fixture-password@example.test/private.git?ref=main&private_token=query-secret',
    ),
    'ssh://example.test/private.git?ref=main',
  );
  assert.equal(
    workspaceTransportDisplayUrl(
      'https://example.test/private.git?ref=main&%61ccess_token=query-secret&X-Amz-Signature=signed-secret',
    ),
    'https://example.test/private.git?ref=main',
  );
  const malformed = workspaceTransportDisplayUrl(
    'https://fixture-user:fixture-password@[invalid-host/private.git?ref=main&token=query-secret',
  );
  assert.doesNotMatch(malformed, /fixture-user|fixture-password|query-secret/);
  assert.match(malformed, /ref=main/);
});

test('credential-free HTTPS, SSH, and file workspace locators remain unchanged', () => {
  const locators = [
    'https://example.test/owner/repo.git?ref=main&depth=1',
    'git@example.test:owner/repo.git',
    'ssh://git@example.test/owner/repo.git',
    'file:///tmp/owner/repo.git',
  ];
  for (const locator of locators) {
    assert.equal(workspaceTransportDisplayUrl(locator), locator);
  }
});
