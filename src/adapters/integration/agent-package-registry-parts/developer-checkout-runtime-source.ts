import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FrameworkContractError } from '../../../kernel/contract-validation.ts';
import { runCommand } from '../system-installation/shared.ts';

function sourceFailure(message: string, details: Record<string, unknown>) {
  return new FrameworkContractError('contract_shape_invalid', message, {
    ...details,
    failure_code: 'agent_package_runtime_source_carrier_invalid',
  });
}

function developerCheckoutGitHead(checkoutPath: string) {
  const result = runCommand('git', ['rev-parse', 'HEAD'], checkoutPath);
  if (result.exitCode !== 0 || result.timedOut || !result.stdout.trim()) {
    throw sourceFailure('Developer checkout runtime source must be a readable Git checkout.', {
      checkout_path: checkoutPath,
    });
  }
  return result.stdout.trim();
}

export function readDeveloperCheckoutSourceIdentity(checkoutPath: string) {
  const sourceGitHeadSha = developerCheckoutGitHead(checkoutPath);
  const diff = runCommand('git', ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'], checkoutPath, {
    maxBuffer: 64 * 1024 * 1024,
  });
  const untracked = runCommand(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    checkoutPath,
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (diff.exitCode !== 0 || diff.timedOut || untracked.exitCode !== 0 || untracked.timedOut) {
    throw sourceFailure('Developer checkout runtime source identity could not be computed.', {
      checkout_path: checkoutPath,
      diff_exit_code: diff.exitCode,
      untracked_exit_code: untracked.exitCode,
    });
  }

  const hash = crypto.createHash('sha256');
  hash.update(`head\0${sourceGitHeadSha}\0diff\0${diff.stdout}\0`);
  const untrackedPaths = untracked.stdout.split('\0').filter(Boolean).sort();
  for (const relativePath of untrackedPaths) {
    const absolutePath = path.join(checkoutPath, relativePath);
    const stat = fs.lstatSync(absolutePath);
    const mode = (stat.mode & 0o777).toString(8);
    if (stat.isSymbolicLink()) {
      hash.update(`symlink\0${relativePath}\0${mode}\0${fs.readlinkSync(absolutePath)}\0`);
    } else if (stat.isFile()) {
      const fileHash = crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
      hash.update(`file\0${relativePath}\0${mode}\0${fileHash}\0`);
    }
  }
  return {
    source_git_head_sha: sourceGitHeadSha,
    tree_sha256: hash.digest('hex'),
  };
}

export type DeveloperCheckoutSourceIdentity = ReturnType<typeof readDeveloperCheckoutSourceIdentity>;
export type ExpectedDeveloperCheckoutSourceIdentity = {
  source_git_head_sha: string | null;
  tree_sha256: string;
};
