import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { KnowledgeBase, assembleRetrievedContext } from '../src/rag/knowledge-base.js';
import { getLocalEmbeddingProvider } from '../src/rag/local-embedding.js';
import { writeSyntheticModel } from '../tests/fixtures/synthetic-embedding-model.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const target = new URL(url);
assert.equal(target.hostname, '127.0.0.1');
assert.equal(target.port, '15432');
assert.equal(target.pathname, '/arc_test');

const root = await mkdtemp(join(tmpdir(), 'arc-embedding-db-'));
const model = join(root, 'original');
const differentModel = join(root, 'changed');
const corpus = `embedding-verify-${randomUUID()}`;
const cleanup = new Client({ connectionString: url });
const databases: KnowledgeBase[] = [];
const previousPath = process.env.ARC_LOCAL_EMBEDDING_PATH;
try {
  await Promise.all([writeSyntheticModel(model), writeSyntheticModel(differentModel)]);
  await writeFile(join(differentModel, 'tokenizer_config.json'),
    JSON.stringify({ tokenizer_class: 'BertTokenizer', model_max_length: 256 }));
  process.env.ARC_LOCAL_EMBEDDING_PATH = model;
  const first = new KnowledgeBase(url, { corpus });
  const otherCorpus = new KnowledgeBase(url, { corpus: `${corpus}-other` });
  process.env.ARC_LOCAL_EMBEDDING_PATH = differentModel;
  const otherModel = new KnowledgeBase(url, { corpus });
  databases.push(first, otherCorpus, otherModel);
  for (const database of databases) {
    await database.connect();
    assert.equal(database.storageMode, 'postgres');
  }
  const rssBefore = process.memoryUsage().rss;
  const start = performance.now();
  const provider = await getLocalEmbeddingProvider(model);
  const initial = await provider.generate('apple');
  const coldMs = performance.now() - start;
  const warmStart = performance.now();
  await Promise.all(Array.from({ length: 8 }, () => provider.generate('apple')));
  const warmBatchMs = performance.now() - warmStart;
  assert.equal(initial.length, 384);
  const ingest = () => first.addWebScrapedDocs('fixture:apple', 'fixture', 'apple apple apple');
  await Promise.all([ingest(), ingest()]);
  await first.addWebScrapedDocs('fixture:pear', 'fixture', 'pear pear pear');
  await otherCorpus.addWebScrapedDocs('fixture:private', 'fixture', 'apple');
  assert.equal((await first.getStats()).totalEntries, 2);
  assert.deepEqual(await otherModel.queryContext('apple'), []);
  const results = await first.queryContext('apple', { threshold: 0 });
  assert.deepEqual(results.map(row => row.metadata.source), ['fixture:apple', 'fixture:pear']);
  assert(results[0]!.similarity > results[1]!.similarity);
  assert(results.every(row => row.metadata.embeddingModel === provider.id && row.metadata.corpus === corpus));
  assert(assembleRetrievedContext(results).includes('fixture:apple'));
  await first.disconnect();
  databases.shift();

  const moduleUrl = new URL('../dist/src/rag/knowledge-base.js', import.meta.url).href;
  const nodeCheck = `
    import assert from 'node:assert/strict';
    const { KnowledgeBase } = await import(process.argv[1]);
    const db = new KnowledgeBase(process.env.DATABASE_URL, { corpus: process.argv[2] });
    await db.connect();
    try {
      assert.equal(db.storageMode, 'postgres');
      const results = await db.queryContext('apple', { threshold: 0 });
      assert.deepEqual(results.map(row => row.metadata.source), ['fixture:apple', 'fixture:pear']);
      assert(results.every(row => row.metadata.embeddingModel === process.argv[3]));
      console.log('NODE_REOPEN_PASS');
    } finally { await db.disconnect(); }
  `;
  const { stdout } = await promisify(execFile)('node', ['--input-type=module', '-e', nodeCheck, moduleUrl, corpus, provider.id], {
    env: { ...process.env, ARC_LOCAL_EMBEDDING_PATH: model }, timeout: 20000, windowsHide: true,
  });
  assert.match(stdout, /NODE_REOPEN_PASS/);
  console.log(JSON.stringify({ status: 'PASS', model: 'locally generated synthetic OneHot graph', dimensions: initial.length,
    modelId: provider.id, coldMs, warmBatchMs, warmRequests: 8, rssDeltaBytes: process.memoryUsage().rss - rssBefore,
    scores: results.map(row => row.similarity), nodeReopen: true }));
} finally {
  if (previousPath === undefined) delete process.env.ARC_LOCAL_EMBEDDING_PATH;
  else process.env.ARC_LOCAL_EMBEDDING_PATH = previousPath;
  await Promise.allSettled(databases.map(database => database.disconnect()));
  try {
    await cleanup.connect();
    await cleanup.query("DELETE FROM knowledge_base WHERE metadata->>'corpus' IN ($1, $2)", [corpus, `${corpus}-other`]);
  } finally {
    await cleanup.end();
    await rm(root, { recursive: true, force: true });
  }
}
