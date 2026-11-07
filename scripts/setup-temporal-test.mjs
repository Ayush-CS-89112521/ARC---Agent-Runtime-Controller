import { spawnSync } from 'node:child_process';
import { writeFile, access } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { Connection } from '@temporalio/client';

const started = spawnSync('docker', ['compose', '-f', 'compose.temporal-test.yaml', 'up', '-d'],
  { stdio: 'inherit', windowsHide: true });
if (started.status !== 0) process.exit(started.status ?? 1);
let ready = false;
for (let attempt = 0; attempt < 30 && !ready; attempt++) {
  let connection;
  try {
    connection = await Connection.connect({ address: '127.0.0.1:17233', connectTimeout: '2 seconds' });
    await connection.workflowService.describeNamespace({ namespace: 'arc-test' });
    ready = true;
  } catch { await setTimeout(500); }
  finally { await connection?.close(); }
}
if (!ready) throw new Error('Isolated Temporal server/namespace did not become available');
let exists = true;
try { await access('.env.temporal-test'); } catch { exists = false; }
if (!exists) await writeFile('.env.temporal-test',
  'TEMPORAL_ADDRESS=127.0.0.1:17233\nTEMPORAL_NAMESPACE=arc-test\nTEMPORAL_TASK_QUEUE=arc-runtime-test\nARC_TEMPORAL_WORKSPACE_ROOT=.arc/temporal-runs\n', { flag: 'wx' });
console.log('PASS: isolated Temporal serving at 127.0.0.1:17233; namespace arc-test. UI: http://127.0.0.1:18233');
