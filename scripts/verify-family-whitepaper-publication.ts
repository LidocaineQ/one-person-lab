#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parsePublicationArgs, verifyPublication } from './verify-whitepaper-publication.ts';

const usage = 'Usage: verify-family-whitepaper-publication.ts --artifact-dir <path> --output <json> [--attempts <n>] [--interval-ms <n>]';

function fail(message: string): never {
  throw new Error(message);
}

function sha256(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function main() {
  const args = parsePublicationArgs(
    process.argv.slice(2),
    'artifact-dir',
    usage,
    '--artifact-dir and --output are required.',
  );
  const manifestPath = path.join(args.sourcePath, 'opl-family-whitepaper-build.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    builds?: Array<{ id: string; verification: string }>;
  };
  if (!Array.isArray(manifest.builds) || manifest.builds.length === 0) fail('Family artifact requires a build manifest.');
  const receiptDir = path.join(path.dirname(args.output), 'whitepaper-publication-receipts');
  fs.mkdirSync(receiptDir, { recursive: true });
  const receipts = await Promise.all(manifest.builds.map(async ({ id, verification }) => {
    if (path.basename(verification) !== verification || !verification.endsWith('.verification.json')) {
      fail(`Invalid verification path for ${id}.`);
    }
    const verificationPath = path.join(args.sourcePath, verification);
    if (!fs.existsSync(verificationPath)) fail(`Missing verification for ${id}: ${verification}`);
    const receiptPath = path.join(receiptDir, `${id}.json`);
    try {
      return await verifyPublication(verificationPath, receiptPath, {
        attempts: args.attempts,
        intervalMs: args.intervalMs,
      });
    } catch {
      return JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as { status: string };
    }
  }));
  const verified = receipts.every(({ status }) => status === 'publication_readback_verified');
  const familyReceipt = {
    schema_version: 'opl_family_whitepaper_publication_receipt.v1',
    status: verified ? 'family_publication_readback_verified' : 'family_publication_readback_failed',
    readback_at: new Date().toISOString(),
    build_manifest_sha256: sha256(manifestPath),
    deployment: {
      repository: process.env.GITHUB_REPOSITORY ?? null,
      run_id: process.env.GITHUB_RUN_ID ?? null,
      deployment_id: process.env.GITHUB_DEPLOYMENT_ID ?? null,
    },
    receipts,
  };
  fs.writeFileSync(args.output, `${JSON.stringify(familyReceipt, null, 2)}\n`, 'utf8');
  if (!verified) fail(`Family publication readback failed; receipt written to ${args.output}`);
  process.stdout.write(`${JSON.stringify(familyReceipt, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
