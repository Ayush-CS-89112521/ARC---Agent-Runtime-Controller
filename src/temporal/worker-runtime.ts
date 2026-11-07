import { NativeConnection, Worker, type WorkerOptions } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import * as activities from './activities/index.js';

export async function createArcWorker(options: {
  address?: string;
  namespace?: string;
  taskQueue?: string;
  identity?: string;
  workflowBundlePath?: string;
  activities?: WorkerOptions['activities'];
} = {}) {
  const connection = await NativeConnection.connect({ address: options.address ?? process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
  try {
    const worker = await Worker.create({
      connection, namespace: options.namespace ?? process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue: options.taskQueue ?? process.env.TEMPORAL_TASK_QUEUE ?? 'arc-workflows',
      ...(options.identity ? { identity: options.identity } : {}),
      ...(options.workflowBundlePath ? { workflowBundle: { codePath: options.workflowBundlePath } }
        : { workflowsPath: fileURLToPath(new URL('./workflows/execute-workflow.js', import.meta.url)) }),
      activities: options.activities ?? activities,
      maxConcurrentActivityTaskExecutions: 10, maxConcurrentWorkflowTaskExecutions: 10,
      maxHeartbeatThrottleInterval: 250, defaultHeartbeatThrottleInterval: 250,
      shutdownGraceTime: '5 seconds',
    });
    return { worker, close: async () => { await activities.cleanup(); await connection.close(); } };
  } catch (error) { await connection.close(); throw error; }
}
