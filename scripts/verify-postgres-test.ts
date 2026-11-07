import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { KnowledgeBase } from '../src/rag/knowledge-base.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not configured');
const target = new URL(connectionString);
if (target.hostname !== '127.0.0.1' || target.port !== '15432' || target.pathname !== '/arc_test') {
  throw new Error('This verification only accepts the isolated local arc_test database');
}
const createClient = () => new Client({ connectionString, connectionTimeoutMillis: 5000 });
const schema = `arc_check_${randomUUID().replace(/-/g, '')}`;
const client = createClient();
const knowledge = new KnowledgeBase(connectionString);
let schemaCreated = false;
try {
  await client.connect();
  await knowledge.connect();
  const table = await client.query("SELECT to_regclass('public.knowledge_base') AS name");
  if (!table.rows[0]?.name) throw new Error('Repository knowledge-base schema was not created in PostgreSQL');
  await client.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await client.query(`CREATE TABLE ${schema}.items (id text PRIMARY KEY, embedding vector(3), metadata jsonb)`);
  await client.query(`INSERT INTO ${schema}.items VALUES ($1, $2, $3), ($4, $5, $6)`,
    ['expected', '[1,0,0]', { source: 'isolated-fixture' }, 'other', '[0,1,0]', { source: 'other' }]);

  await client.query('BEGIN');
  await client.query(`INSERT INTO ${schema}.items VALUES ('rolled_back', '[0,0,1]', '{}')`);
  await client.query('ROLLBACK');
  const rollback = await client.query(`SELECT count(*)::int AS count FROM ${schema}.items WHERE id = 'rolled_back'`);
  if (rollback.rows[0].count !== 0) throw new Error('Transaction rollback failed');

  await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const concurrent = createClient();
    try {
      await concurrent.connect();
      await concurrent.query(`INSERT INTO ${schema}.items VALUES ($1, '[0,0,1]', '{}')`, [`concurrent_${index}`]);
    } finally { await concurrent.end(); }
  }));

  const reopened = createClient();
  try {
    await reopened.connect();
    const result = await reopened.query(`SELECT id, metadata, 1 - (embedding <=> $1::vector) AS similarity FROM ${schema}.items ORDER BY embedding <=> $1::vector LIMIT 1`, ['[1,0,0]']);
    if (result.rows[0]?.id !== 'expected' || Number(result.rows[0]?.similarity) !== 1 || result.rows[0]?.metadata.source !== 'isolated-fixture') {
      throw new Error('Persisted vector retrieval failed');
    }
    const total = await reopened.query(`SELECT count(*)::int AS count FROM ${schema}.items`);
    if (total.rows[0].count !== 6) throw new Error('Concurrent persistence failed');
    let rejected = false;
    try { await reopened.query(`INSERT INTO ${schema}.items VALUES ('invalid', '[1,2]', '{}')`); }
    catch { rejected = true; }
    if (!rejected) throw new Error('Invalid vector dimension was accepted');
  } finally { await reopened.end(); }
  console.log('PASS: actual PostgreSQL connection, repository schema initialization, persistence/reconnect, vector retrieval, metadata, rollback, four concurrent clients, and invalid-dimension rejection.');
  console.log('Embedding inference was not exercised; vector fixtures were deterministic.');
} finally {
  if (schemaCreated) await client.query(`DROP SCHEMA ${schema} CASCADE`);
  await knowledge.disconnect();
  await client.end();
}
