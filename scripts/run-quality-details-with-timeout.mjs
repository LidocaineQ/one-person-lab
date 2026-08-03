#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const [timeoutRaw, qualityDetailsBin, compareRef, limit, focus] = process.argv.slice(2);
const timeoutSeconds = Number(timeoutRaw);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error(`Invalid OPL_QUALITY_DETAILS_TIMEOUT_SECONDS: ${timeoutRaw}`);
  process.exit(64);
}

const result = spawnSync(
  qualityDetailsBin,
  [
    'quality',
    'details',
    '--root',
    '.',
    '--format',
    'markdown',
    '--limit',
    limit,
    '--focus',
    focus,
    '--compare-ref',
    compareRef,
  ],
  {
    stdio: 'inherit',
    timeout: timeoutSeconds * 1000,
    killSignal: 'SIGKILL',
  },
);

if (result.error?.code === 'ETIMEDOUT') {
  process.exit(124);
}
if (result.error) {
  console.error(result.error.message);
  process.exit(127);
}
if (result.signal) {
  console.error(`OPL quality details terminated by signal: ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 0);
