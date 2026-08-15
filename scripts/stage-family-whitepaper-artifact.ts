#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type BuildManifest = {
  builds: Array<{
    id: string;
    repo_root: string;
    verification: {
      generated_html: string;
      generated_pdf: string;
      rendered_dir: string;
    };
  }>;
};

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]) {
  if (argv.length !== 4 || argv[0] !== '--manifest' || argv[2] !== '--output') {
    fail('Usage: node scripts/stage-family-whitepaper-artifact.ts --manifest <path> --output <path>');
  }
  return { manifest: path.resolve(argv[1]), output: path.resolve(argv[3]) };
}

function copy(source: string, target: string) {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) fail(`Missing whitepaper artifact: ${source}`);
  fs.copyFileSync(source, target);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8')) as BuildManifest;
  if (!Array.isArray(manifest.builds) || manifest.builds.length === 0) fail('Family build manifest must contain builds.');
  const whitepaperDir = path.join(args.output, 'whitepapers');
  const evidenceDir = path.join(args.output, 'evidence');
  fs.mkdirSync(whitepaperDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  for (const build of manifest.builds) {
    const htmlName = path.basename(build.verification.generated_html);
    const pdfName = path.basename(build.verification.generated_pdf);
    const verificationName = `${path.basename(htmlName, '.html')}.verification.json`;
    copy(path.join(build.repo_root, build.verification.generated_html), path.join(whitepaperDir, htmlName));
    copy(path.join(build.repo_root, build.verification.generated_pdf), path.join(whitepaperDir, pdfName));
    copy(
      path.join(build.repo_root, 'docs', 'site', 'latest', 'whitepapers', verificationName),
      path.join(whitepaperDir, verificationName),
    );
    const renderedDir = path.join(build.repo_root, build.verification.rendered_dir);
    if (!fs.existsSync(renderedDir) || !fs.statSync(renderedDir).isDirectory()) {
      fail(`Missing rendered page evidence: ${renderedDir}`);
    }
    fs.cpSync(renderedDir, path.join(evidenceDir, build.id, 'rendered-pages'), { recursive: true });
  }
  const firstBuild = manifest.builds.find(({ id }) => id === 'opl-family') ?? manifest.builds[0];
  const catalog = path.join(firstBuild.repo_root, 'docs', 'site', 'latest', 'whitepapers', 'index.html');
  if (fs.existsSync(catalog)) copy(catalog, path.join(whitepaperDir, 'index.html'));
  fs.copyFileSync(args.manifest, path.join(whitepaperDir, 'opl-family-whitepaper-build.json'));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
