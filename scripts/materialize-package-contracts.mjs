#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageContracts = {
  'cordis-abi': [
    'cordis-plugin-descriptor.schema.json',
    'cordis-composition-snapshot.schema.json',
  ],
  'package-host': [
    'package-host-context.schema.json',
    'package-host-integration.schema.json',
    'standard-agent-host-contract.json',
    'capability-package-host-contract.json',
    'workflow-profile-host-contract.json',
  ],
};

const args = new Set(process.argv.slice(2));
const requestedPackage = process.argv.find((value) => value.startsWith('--package='))?.slice('--package='.length);
const checkOnly = args.has('--check');
const selectedPackages = requestedPackage
  ? [requestedPackage]
  : Object.keys(packageContracts);

for (const packageName of selectedPackages) {
  const files = packageContracts[packageName];
  if (!files) {
    throw new Error(`Unknown package contract set: ${packageName}`);
  }
  for (const file of files) {
    const source = path.join(rootDir, 'contracts', 'opl-framework', file);
    const target = path.join(rootDir, 'packages', packageName, 'contracts', file);
    const sourceBytes = fs.readFileSync(source);
    const targetBytes = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (checkOnly) {
      if (!targetBytes || !sourceBytes.equals(targetBytes)) {
        throw new Error(`Package contract is not materialized from the Framework source: ${path.relative(rootDir, target)}`);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!targetBytes || !sourceBytes.equals(targetBytes)) {
      fs.writeFileSync(target, sourceBytes);
    }
  }
}

if (checkOnly) {
  process.stdout.write('Package contract copies match Framework sources.\n');
}
