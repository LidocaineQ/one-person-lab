import fs from 'node:fs';

import { parseJsonText } from '../../src/kernel/json-file.ts';
import {
  writeStorageOwnerInventoryProjection,
  type StorageOwnerProjection,
} from '../../src/adapters/integration/storage-owner-inventory-snapshot.ts';

const [section, projectionJson, readyFile, startFile] = process.argv.slice(2);
if (
  (section !== 'agent_package_store' && section !== 'webui_data_volume')
  || !projectionJson
  || !readyFile
  || !startFile
) {
  throw new Error('storage owner inventory writer fixture arguments are incomplete');
}

fs.writeFileSync(readyFile, 'ready\n');
const waiter = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(startFile)) {
  Atomics.wait(waiter, 0, 0, 10);
}

writeStorageOwnerInventoryProjection(
  section,
  parseJsonText(projectionJson) as StorageOwnerProjection,
);
