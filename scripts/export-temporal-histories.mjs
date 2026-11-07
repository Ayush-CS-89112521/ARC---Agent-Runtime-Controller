import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { Client, Connection } from '@temporalio/client';
import { historyToJSON } from '@temporalio/common/proto-utils';

const base = path.resolve('.audit/temporal');
const directories = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith('arc-verify-'));
const connection = await Connection.connect({ address: '127.0.0.1:17233' });
try {
  const client = new Client({ connection, namespace: 'arc-test' });
  for (const directory of directories) {
    const dir = path.join(base, directory.name);
    const metadata = JSON.parse(await readFile(path.join(dir, 'results.json'), 'utf8'));
    assert.equal(metadata.suite, directory.name);
    let exported = 0;
    for (const filename of await readdir(dir)) {
      if (!filename.endsWith('-history.json')) continue;
      const label = filename.slice(0, -'-history.json'.length);
      const suffix = label === 'success' ? 'api-client' : label === 'bug-crash-cancellation' ? 'crash-during-cancellation' : label;
      const history = await client.workflow.getHandle(`${metadata.suite}-${suffix}`).fetchHistory();
      const message = JSON.parse(historyToJSON(history));
      assert.ok(message.events.length > 0);
      await writeFile(path.join(dir, filename), JSON.stringify(message, null, 2));
      exported++;
    }
    console.log(`Exported actual server events: ${directory.name}, ${exported} histories`);
  }
} finally { await connection.close(); }
