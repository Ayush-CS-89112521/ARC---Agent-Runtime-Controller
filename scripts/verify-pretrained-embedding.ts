import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { ArchitectAgent } from '../src/agents/architect.js';
import { ArchitectService } from '../src/services/architect-service.js';
import { ExecutableRegistry } from '../src/tools/executable-registry.js';
import { registerLocalTools } from '../src/tools/local-adapters.js';
import { KnowledgeBase, assembleRetrievedContext } from '../src/rag/knowledge-base.js';
import { getLocalEmbeddingProvider } from '../src/rag/local-embedding.js';

const examples = [
  ['pgvector', 'PostgreSQL pgvector stores dense embeddings in a vector column. Cosine distance ranks nearest neighbors in SQL, with HNSW or IVFFlat indexes for approximate search.',
    'How can a relational database persist embedding arrays and find nearby ones?', 'Which Postgres extension supports approximate nearest neighbor search?'],
  ['typescript', 'TypeScript narrows a union using a discriminant field or an explicit type guard. The compiler checks types statically and emits JavaScript.',
    'How do I refine a union to one variant using its tag?', 'Which language checks JavaScript types before runtime?'],
  ['temporal', 'Temporal records workflow event history and replays deterministic workflow code after a worker restarts. Activities can retry, so external effects need idempotency.',
    'How can an orchestration resume after its worker dies?', 'How does a durable workflow recover using a log of past events?'],
  ['containers', 'Container images package applications and their userspace dependencies into immutable layers. Docker runs isolated processes from these images without creating a separate guest kernel.',
    'How can I ship an application with a consistent userspace across machines?', 'Why are Docker workloads lighter than full virtual machines?'],
  ['embeddings', 'A sentence encoder maps text to dense semantic representations. Mean pooling averages token representations and L2 normalization makes dot product comparable to cosine similarity.',
    'How do I turn a sentence into a unit vector for meaning comparison?', 'How can token hidden states be combined into one representation of text?'],
  ['scheduling', 'An operating system scheduler selects which runnable process gets CPU time. Round robin gives each task a time quantum, preempting it when the slice expires.',
    'What decides which runnable process uses a CPU core next?', 'Which scheduling policy cycles through tasks with fixed time slices?'],
  ['transactions', 'A database transaction groups changes atomically. Rolling back discards uncommitted updates, while isolation controls visibility between concurrent transactions.',
    'How do I undo several uncommitted SQL updates together?', 'What guarantees that a batch of writes either all succeeds or none takes effect?'],
  ['tls', 'TLS encrypts data in transit. During the handshake the client verifies the server certificate chain and hostname before establishing session keys.',
    'How does HTTPS verify that it is talking to the intended server?', 'How can data be protected against eavesdropping while crossing a network?'],
  ['queues', 'Message queues decouple producers and consumers. At-least-once delivery may redeliver messages after an acknowledgement is lost, so consumers should deduplicate.',
    'Why might an asynchronous consumer see the same message twice?', 'How do I decouple a publisher from a slower subscriber?'],
  ['memory', 'Virtual memory maps process addresses to physical pages. Accessing a page that is absent triggers a page fault and may require reading it from disk.',
    'What happens when a program touches a page absent from RAM?', 'How can each process have its own address space?'],
  ['cicd', 'Continuous integration automatically builds and tests a change on each pull request. A delivery pipeline promotes verified artifacts to staging before deployment.',
    'How can pull requests automatically run tests before merging?', 'How do I promote a verified build to a staging environment?'],
  ['git', 'Git rebase rewrites commits onto a new base. Merge preserves existing commits and can add a merge commit to combine histories.',
    'How can I replay my branch commits on top of a newer main branch?', 'What is the difference between preserving branch history and rewriting commits?'],
] as const;

const url = process.env.DATABASE_URL;
const path = process.env.ARC_LOCAL_EMBEDDING_PATH;
if (!url || !path) throw new Error('Set DATABASE_URL and ARC_LOCAL_EMBEDDING_PATH');
const target = new URL(url);
assert.equal(target.hostname, '127.0.0.1');
assert.equal(target.port, '15432');
assert.equal(target.pathname, '/arc_test');
const corpus = `pretrained-verify-${randomUUID()}`;
const db = new KnowledgeBase(url, { corpus });
const privateDb = new KnowledgeBase(url, { corpus: `${corpus}-private` });
const otherModel = new KnowledgeBase(url, { corpus, embedding: {
  id: 'verification-other-model', generate: async () => [1, ...Array<number>(383).fill(0)],
} });
const cleanup = new Client({ connectionString: url });
const temp = await mkdtemp(join(tmpdir(), 'arc-pretrained-retry-'));
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
const lexical = (q: string) => {
  const query = words(q);
  return examples.map(([id, text]) => ({ id, count: [...words(text)].filter(word => query.has(word)).length }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)).map(row => row.id);
};
const metrics = (ranks: number[]) => ({
  recallAt1: ranks.filter(rank => rank === 1).length / ranks.length,
  recallAt3: ranks.filter(rank => rank > 0 && rank <= 3).length / ranks.length,
  mrr: ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length,
});

try {
  await Promise.all([db, privateDb, otherModel].map(item => item.connect()));
  for (const item of [db, privateDb, otherModel]) assert.equal(item.storageMode, 'postgres');
  const start = performance.now();
  const provider = await getLocalEmbeddingProvider(path);
  const vector = await provider.generate(examples[0][2]);
  const coldMs = performance.now() - start;
  assert.equal(vector.length, 384);
  assert(vector.every(Number.isFinite));
  const norm = Math.hypot(...vector);
  assert(Math.abs(norm - 1) < 1e-4);
  const warmStart = performance.now();
  assert.deepEqual(await provider.generate(examples[0][2]), vector);
  const warmSingleMs = performance.now() - warmStart;
  const concurrentStart = performance.now();
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => provider.generate(examples[0][2])));
  const warmConcurrentMs = performance.now() - concurrentStart;
  for (const result of concurrent) assert.deepEqual(result, vector);
  await assert.rejects(db.queryContext('  '), /Invalid retrieval/);

  const ingest = ([id, text]: typeof examples[number]) => db.addWebScrapedDocs(id, 'pretrained-evaluation', text);
  for (const example of examples) await ingest(example);
  await Promise.all([ingest(examples[0]), ingest(examples[0])]);
  await privateDb.addWebScrapedDocs('private', 'private', examples[0][1]);
  assert.equal((await db.getStats()).totalEntries, examples.length);
  assert.deepEqual(await otherModel.queryContext(examples[0][2]), []);
  const rows = [];
  for (const [expected, , ...queries] of examples) {
    for (const query of queries) {
      const ranked = await db.queryContext(query, { threshold: -1, limit: examples.length });
      assert.equal(ranked.length, examples.length);
      assert(ranked.every(row => row.metadata.corpus === corpus && row.metadata.embeddingModel === provider.id));
      const rank = ranked.findIndex(row => row.metadata.source === expected) + 1;
      const best = ranked[0]!;
      rows.push({ query, expected, rank, top: best.metadata.source, bestScore: best.similarity,
        relevantScore: ranked[rank - 1]?.similarity, lexicalRank: lexical(query).indexOf(expected) + 1 });
    }
  }
  const firstQuery = examples[0][2];
  const first = await db.queryContext(firstQuery, { threshold: -1, limit: 3 });
  const context = assembleRetrievedContext(first);
  assert(context.includes('"source":"pgvector"') && context.includes(provider.id));
  assert(first.every(row => row.metadata.chunk === 0 && row.metadata.documentId && row.metadata.timestamp instanceof Date));
  let fixtureCalls = 0;
  const planner = new ArchitectAgent({}, async prompt => {
    fixtureCalls++;
    assert(prompt.includes('UNTRUSTED REFERENCE DATA') && prompt.includes('"source":"pgvector"'));
    return JSON.stringify({ steps: [{ step_id: 0, step_name: 'Read the reference',
      tool_needed: 'local.read_file', reasoning: 'Read the local reference', expected_output: 'Source pgvector',
      input: { path: 'reference.txt' }, dependencies: [] }], confidence_score: 1, execution_order: [0] });
  });
  const catalog = registerLocalTools(new ExecutableRegistry(), temp).catalog();
  const plan = await new ArchitectService({}, catalog, planner).createPlanFromRequest(
    'Read the reference file for the embedding database', undefined, context,
  );
  assert(!('error_code' in plan));
  assert.equal(fixtureCalls, 1);
  const moduleUrl = new URL('../dist/src/rag/knowledge-base.js', import.meta.url).href;
  const reopen = `
    import assert from 'node:assert/strict';
    const { KnowledgeBase } = await import(process.argv[1]);
    const db = new KnowledgeBase(process.env.DATABASE_URL, { corpus: process.argv[2] });
    await db.connect();
    try {
      assert.equal(db.storageMode, 'postgres');
      const rows = await db.queryContext(process.argv[3], { threshold: -1, limit: 3 });
      console.log('REOPEN=' + JSON.stringify(rows.map(r => [r.metadata.source, r.metadata.embeddingModel])));
    } finally { await db.disconnect(); }
  `;
  const { stdout } = await promisify(execFile)('node', ['--input-type=module', '-e', reopen, moduleUrl, corpus, firstQuery], {
    env: { ...process.env }, timeout: 45000, windowsHide: true,
  });
  const reopened = stdout.split(/\r?\n/).find(line => line.startsWith('REOPEN='));
  assert(reopened);
  assert.deepEqual(JSON.parse(reopened.slice(7)), first.map(row => [row.metadata.source, provider.id]));

  const peakRssKiB = process.resourceUsage().maxRSS;
  await assert.rejects(getLocalEmbeddingProvider(temp), /initialization failed/);
  await mkdir(join(temp, 'onnx'));
  for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) {
    await copyFile(join(path, name), join(temp, name));
  }
  const recovered = await getLocalEmbeddingProvider(temp);
  assert.equal(recovered.id, provider.id);
  assert.deepEqual(await recovered.generate(firstQuery), vector);
  console.log(JSON.stringify({ status: 'PASS', dimensions: vector.length, norm, coldMs, warmSingleMs, warmConcurrentMs,
    concurrentRequests: concurrent.length, peakRssKiB, modelId: provider.id, documents: examples.length,
    queries: rows.length, semantic: metrics(rows.map(row => row.rank)), lexical: metrics(rows.map(row => row.lexicalRank)),
    thresholdAtPointSeven: metrics(rows.map(row => (row.relevantScore ?? -1) >= 0.7 ? row.rank : 0)),
    independentNodeReopen: true, architectFixture: true, failedInitializationRecovered: true, results: rows }, null, 2));
} finally {
  await Promise.allSettled([db, privateDb, otherModel].map(item => item.disconnect()));
  try {
    await cleanup.connect();
    await cleanup.query("DELETE FROM knowledge_base WHERE metadata->>'corpus' IN ($1, $2)", [corpus, `${corpus}-private`]);
  } finally {
    await cleanup.end();
    await rm(temp, { recursive: true, force: true });
  }
}
