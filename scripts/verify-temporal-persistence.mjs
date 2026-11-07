import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';

const latest = JSON.parse(await readFile('.audit/temporal/latest.json', 'utf8'));
assert.ok(latest.suite.startsWith('arc-verify-'));
const ids = ['api-client', 'crash-during-cancellation', 'unsafe-retry'].map(suffix => `${latest.suite}-${suffix}`);
async function snapshot() {
  const connection = await Connection.connect({ address: '127.0.0.1:17233', connectTimeout: '2 seconds' });
  try {
    const client = new Client({ connection, namespace: 'arc-test' });
    return await Promise.all(ids.map(async workflowId => {
      const handle = client.workflow.getHandle(workflowId);
      const [description, history] = await Promise.all([handle.describe(), handle.fetchHistory()]);
      return { workflowId, runId: description.runId, status: description.status.name, eventCount: history.events.length };
    }));
  } finally { await connection.close(); }
}
const before = await snapshot();
const restarted = spawnSync('docker', ['compose', '-f', 'compose.temporal-test.yaml', 'restart', 'temporal'],
  { stdio: 'inherit', windowsHide: true });
assert.equal(restarted.status, 0);
let after;
for (let attempt = 0; attempt < 30; attempt++) {
  try { after = await snapshot(); break; } catch { await setTimeout(500); }
}
assert.deepEqual(after, before);
await writeFile('.audit/temporal/server-restart.json', JSON.stringify({ status: 'PASS', before, after }, null, 2));
console.log('PASS: three representative histories, run IDs and terminal statuses survived the isolated server restart.');
