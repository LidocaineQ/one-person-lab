#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { verifyPublication } from './verify-whitepaper-publication.ts';

function fail(message: string): never {
  throw new Error(message);
}

function positiveInteger(value: string | undefined, fallback: number, label: string) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) fail(`${label} must be a positive integer.`);
  return parsed;
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--artifact-dir', '--output', '--attempts', '--interval-ms'].includes(flag) || !value || values.has(flag)) {
      fail('Usage: verify-family-whitepaper-publication.ts --artifact-dir <path> --output <json> [--attempts <n>] [--interval-ms <n>]');
    }
    values.set(flag, value);
  }
  const artifactDir = values.get('--artifact-dir');
  const output = values.get('--output');
  if (!artifactDir || !output) fail('--artifact-dir and --output are required.');
  return {
    artifactDir: path.resolve(artifactDir),
    output: path.resolve(output),
    attempts: positiveInteger(values.get('--attempts'), 6, '--attempts'),
    intervalMs: positiveInteger(values.get('--interval-ms'), 10_000, '--interval-ms'),
  };
}

function sha256(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(args.artifactDir, 'opl-family-whitepaper-build.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { builds?: Array<{ id: string }> };
  if (!Array.isArray(manifest.builds) || manifest.builds.length === 0) fail('Family artifact requires a build manifest.');
  const receiptDir = path.join(path.dirname(args.output), 'whitepaper-publication-receipts');
  fs.mkdirSync(receiptDir, { recursive: true });
  const receipts = await Promise.all(manifest.builds.map(async ({ id }) => {
    const verificationFiles = fs.readdirSync(args.artifactDir).filter((name) => name.endsWith('.verification.json'));
    const verificationFile = verificationFiles.find((name) => {
      const verification = JSON.parse(fs.readFileSync(path.join(args.artifactDir, name), 'utf8')) as { source_markdown?: string };
      return id === 'opl-family'
        ? verification.source_markdown?.endsWith('/opl-whitepaper.md')
        : id === 'opl-framework'
          ? verification.source_markdown?.endsWith('/opl-framework-whitepaper.md')
          : verification.source_markdown?.includes(`/${id}-whitepaper.md`);
    });
    if (!verificationFile) fail(`Missing verification for ${id}.`);
    const verificationPath = path.join(args.artifactDir, verificationFile);
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
