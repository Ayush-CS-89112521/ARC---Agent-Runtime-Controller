import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker, Runtime, DefaultLogger } from '@temporalio/worker';

Runtime.install({ logger: new DefaultLogger('WARN') });
const latest = JSON.parse(await readFile('.audit/temporal/latest.json', 'utf8'));
const index = JSON.parse(await readFile(path.join(latest.evidence, 'histories-index.json'), 'utf8'));
const start = Date.now();
for (const entry of index) {
  const history = JSON.parse(await readFile(path.join(latest.evidence, `${entry.label}-history.json`), 'utf8'));
  await Worker.runReplayHistory({ workflowBundle: { codePath: path.join(latest.evidence, 'workflows.js') } }, history, entry.workflowId);
}
const result = { status: 'PASS', historiesReplayed: index.length, durationMs: Date.now() - start };
await writeFile(path.join(latest.evidence, 'replay-from-disk.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
