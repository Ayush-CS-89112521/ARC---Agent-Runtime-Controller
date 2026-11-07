import { createArcWorker } from './worker-runtime.js';

async function main() {
  const runtime = await createArcWorker();
  const shutdown = () => runtime.worker.shutdown();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    console.log('Temporal worker registered; polling configured namespace/task queue.');
    await runtime.worker.run();
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    await runtime.close();
  }
}
main().catch(error => { console.error('Temporal worker failed:', error); process.exitCode = 1; });
