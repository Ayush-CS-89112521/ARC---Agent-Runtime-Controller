import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import ts from 'typescript-eslint';

const lint = new ESLint();
const matches = await lint.lintFiles(['src/rag/*.ts']);
assert(matches.length >= 2);
assert(matches.every(file => file.errorCount === 0));
const [invalid] = await lint.lintText('debugger;', { filePath: 'src/lint-fixture.ts' });
assert(invalid.messages.some(message => message.ruleId === 'no-debugger'));

const cwd = await mkdtemp(join(tmpdir(), 'arc-lint-project-'));
try {
  const included = join(cwd, 'included.ts');
  const allowed = join(cwd, 'extra.fixture.ts');
  const excluded = join(cwd, 'excluded.ts');
  await Promise.all([
    writeFile(join(cwd, 'tsconfig.json'), '{"files":["included.ts"]}'),
    ...[included, allowed, excluded].map(file => writeFile(file, 'export const value = 1;')),
  ]);
  const options = { tsconfigRootDir: cwd, projectService: { allowDefaultProject: ['*.fixture.ts'] } };
  const parsed = ts.parser.parseForESLint('export const value = 1;', { ...options, filePath: allowed });
  assert(parsed.services.program);
  assert.throws(() => ts.parser.parseForESLint('export const value = 1;', { ...options, filePath: excluded }),
    /allowDefaultProject/);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
console.log('ESLint file/config globs and TypeScript project-service allowlist passed');
