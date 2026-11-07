import { appendFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@temporalio/activity';
import { Runtime, DefaultLogger } from '@temporalio/worker';
import { z } from 'zod';
import { createArcWorker } from '../../dist/src/temporal/worker-runtime.js';
import { createBuilderExecutionActivity } from '../../dist/src/temporal/activities/builder-activity.js';
import { ExecutableRegistry } from '../../dist/src/tools/executable-registry.js';
import { registerLocalTools } from '../../dist/src/tools/local-adapters.js';

Runtime.install({ logger: new DefaultLogger('WARN') });
const emit = event => process.send?.({ ...event, pid: process.pid, at: new Date().toISOString() });
const execute = createBuilderExecutionActivity({
  workspaceRoot: process.env.ARC_TEMPORAL_FIXTURE_ROOT,
  observe: async event => {
    emit(event);
    if ((event.phase === 'completed' && process.env.ARC_HOLD_COMPLETION === '1' && event.attempt === 1)
      || (event.phase === 'cancelled' && process.env.ARC_HOLD_CANCEL_ACK === '1')) await delay(60000);
  },
  runtimeFactory: async workspace => {
    const registry = registerLocalTools(new ExecutableRegistry(), workspace, join(dirname(workspace), '.write-journal', basename(workspace)));
    const permissions = new Set(['files.read', 'files.write', 'fixture.wait', 'fixture.fail', 'fixture.append']);
    registry.register({ id: 'fixture.wait', name: 'wait', description: 'Cancellable isolated wait', permission: 'fixture.wait', requiresApproval: false,
      input: z.object({ ms: z.number().min(0).max(60000) }).strict(), output: z.string(),
      execute: async (input, invocation) => {
        emit({ phase: 'wait-start', workspace, workflowId: Context.current().info.workflowExecution.workflowId });
        try { await delay(input.ms, undefined, { signal: invocation.signal }); return 'wait-complete'; }
        catch (error) { emit({ phase: 'wait-aborted', workspace }); throw error; }
      },
    });
    registry.register({ id: 'fixture.fail', name: 'fail', description: 'Controlled fixture exception', permission: 'fixture.fail', requiresApproval: false,
      input: z.object({}).strict(), output: z.string(), execute: async () => { throw new Error('Controlled tool failure'); },
    });
    registry.register({ id: 'fixture.append', name: 'append', description: 'Non-idempotent isolated append', permission: 'fixture.append', requiresApproval: true,
      input: z.object({}).strict(), output: z.object({ appended: z.literal(true) }),
      execute: async () => {
        await appendFile(join(workspace, 'effects.log'), `effect-attempt-${Context.current().info.attempt}\n`);
        emit({ phase: 'side-effect', workspace, attempt: Context.current().info.attempt });
        return { appended: true };
      },
    });
    return { registry, permissions, close: async () => {} };
  },
});

const runtime = await createArcWorker({ address: '127.0.0.1:17233', namespace: 'arc-test',
  taskQueue: process.env.ARC_TEMPORAL_FIXTURE_QUEUE, identity: `arc-verification-${process.pid}`,
  workflowBundlePath: process.env.ARC_TEMPORAL_FIXTURE_BUNDLE,
  activities: process.env.ARC_WORKFLOW_ONLY === '1' ? {} : { executeBuilderWorkflowActivity: execute },
});
const shutdown = () => runtime.worker.shutdown();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.on('message', message => { if (message === 'shutdown') shutdown(); });
emit({ phase: 'ready' });
try { await runtime.worker.run(); }
finally {
  await runtime.close();
  if (process.connected) process.disconnect();
}
