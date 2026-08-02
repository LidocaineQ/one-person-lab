import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveNativeTemporaryRoot } from '../../../../../src/kernel/native-temp-root.ts';

test('package temporary roots stay on a native filesystem when Windows temp is inherited by WSL', () => {
  const mountInfo = [
    '36 25 8:32 / / rw,relatime - ext4 /dev/sdc rw',
    '97 36 0:42 / /mnt/c rw,noatime - 9p drvfs rw,aname=drvfs',
  ].join('\n');
  assert.equal(resolveNativeTemporaryRoot({
    platform: 'linux',
    systemTemporaryRoot: '/mnt/c/Users/example/AppData/Local/Temp',
    linuxMountInfo: mountInfo,
  }), '/tmp');
  assert.equal(resolveNativeTemporaryRoot({
    platform: 'linux',
    systemTemporaryRoot: '/tmp/opl',
    linuxMountInfo: mountInfo,
  }), '/tmp/opl');
  assert.equal(resolveNativeTemporaryRoot({
    platform: 'win32',
    systemTemporaryRoot: '/mnt/c/Users/example/AppData/Local/Temp',
    linuxMountInfo: mountInfo,
  }), '/mnt/c/Users/example/AppData/Local/Temp');
});
