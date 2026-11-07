import { randomBytes } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { Client } from 'pg';

const secretsFile = '.env.postgres-test';
const exists = async file => { try { await access(file); return true; } catch { return false; } };
const docker = args => {
  const result = spawnSync('docker', args, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(`Docker command failed (${result.status ?? 'unavailable'})`);
};

try {
  if (!(await exists(secretsFile))) {
    await writeFile(secretsFile,
      `ARC_POSTGRES_ADMIN_PASSWORD=${randomBytes(32).toString('hex')}\nARC_POSTGRES_APP_PASSWORD=${randomBytes(32).toString('hex')}\n`,
      { flag: 'wx', mode: 0o600 });
  }
  process.loadEnvFile(secretsFile);
  const adminPassword = process.env.ARC_POSTGRES_ADMIN_PASSWORD;
  const appPassword = process.env.ARC_POSTGRES_APP_PASSWORD;
  if (!/^[a-f0-9]{64}$/.test(adminPassword ?? '') || !/^[a-f0-9]{64}$/.test(appPassword ?? '')) {
    throw new Error('Unexpected test credential format; existing credentials were preserved');
  }
  docker(['compose', '--env-file', secretsFile, '-f', 'compose.postgres-test.yaml', 'up', '-d', '--wait', '--wait-timeout', '120']);
  let admin;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = new Client({ host: '127.0.0.1', port: 15432, user: 'arc_test_admin', database: 'arc_test',
      password: adminPassword, connectionTimeoutMillis: 2000 });
    try { await candidate.connect(); admin = candidate; break; }
    catch { await candidate.end().catch(() => {}); await setTimeout(1000); }
  }
  if (!admin) throw new Error('Test database did not become available');
  try {
    const roles = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'arc_app'");
    // Generated hex credentials cannot inject SQL. Keep passwords out of shell args and output.
    if (roles.rowCount === 0) await admin.query(`CREATE ROLE arc_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${appPassword}'`);
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query('ALTER DATABASE arc_test OWNER TO arc_app');
    await admin.query('GRANT USAGE, CREATE ON SCHEMA public TO arc_app');
    const info = await admin.query("SELECT current_setting('server_version') AS postgres, extversion AS pgvector FROM pg_extension WHERE extname = 'vector'");
    console.log('Installed test database:', JSON.stringify(info.rows[0]));
  } finally { await admin.end(); }

  const databaseUrl = `postgresql://arc_app:${appPassword}@127.0.0.1:15432/arc_test`;
  const existing = await exists('.env') ? await readFile('.env', 'utf8') : '';
  const databaseSetting = existing.match(/^\s*(?:export\s+)?DATABASE_URL\s*=.*$/m);
  if (databaseSetting && !databaseSetting[0].includes('@127.0.0.1:15432/arc_test')) {
    throw new Error('An existing DATABASE_URL was preserved. The local database is ready; choose its environment explicitly.');
  }
  if (!databaseSetting) await writeFile('.env', `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}DATABASE_URL=${databaseUrl}\n`, { mode: 0o600 });
  const app = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    await app.connect();
    const privilege = await app.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    if (privilege.rows[0]?.rolsuper !== false) throw new Error('App role must not be a superuser');
  } finally { await app.end(); }
  console.log('PASS: PostgreSQL + pgvector running on 127.0.0.1:15432; non-superuser app login verified.');
  console.log('DATABASE_URL saved to git-ignored .env. Credentials were not printed.');
} catch (error) {
  console.error('PostgreSQL setup failed:', error?.code ?? error.message);
  process.exitCode = 1;
}
