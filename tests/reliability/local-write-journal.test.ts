import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutableRegistry } from '../../src/tools/executable-registry';
import { registerLocalTools } from '../../src/tools/local-adapters';

async function fixture(run: (workspace: string, journal: string, registry: ExecutableRegistry) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'arc-write-journal-'));
  const workspace = join(root, 'workspace');
  const journal = join(root, 'journal');
  try {
    await mkdir(workspace);
    await run(workspace, journal, registerLocalTools(new ExecutableRegistry(), workspace, journal));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const grants = { permissions: new Set(['files.write']), approved: true, signal: new AbortController().signal,
  timeoutMs: 5000, operationId: 'original-operation' };
const input = { path: 'effect.txt', content: 'one write' };

test('concurrent and repeated writes reconcile a published file without recreating it', () =>
  fixture(async (workspace, journal, registry) => {
    const invoke = () => registry.invoke('local.write_file', input, grants);
    expect(await Promise.all(Array.from({ length: 8 }, invoke))).toEqual(
      Array.from({ length: 8 }, () => ({ path: 'effect.txt', created: true })),
    );
    const file = join(workspace, input.path);
    const before = await stat(file, { bigint: true });
    const operation = createHash('sha256').update(grants.operationId).digest('hex');
    // Recreate the state visible after publication and before recording completion.
    await unlink(join(journal, operation, 'completed'));
    expect(await invoke()).toEqual({ path: 'effect.txt', created: true });
    const after = await stat(file, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(await readFile(file, 'utf8')).toBe(input.content);
    await expect(registry.invoke('local.write_file', { ...input, content: 'different' }, grants)).rejects.toThrow('conflicts');
    await unlink(file);
    await expect(invoke()).rejects.toThrow('destination is missing');
  }));

test('the journal refuses identical pre-existing files and keeps permission, approval and cancellation checks', () =>
  fixture(async (workspace, _journal, registry) => {
    const file = join(workspace, input.path);
    await writeFile(file, input.content);
    await expect(registry.invoke('local.write_file', input, grants)).rejects.toThrow('another operation');
    expect(await readFile(file, 'utf8')).toBe(input.content);
    await expect(registry.invoke('local.write_file', input, { ...grants, approved: false })).rejects.toThrow('Approval required');
    await expect(registry.invoke('local.write_file', input, { ...grants, permissions: new Set() })).rejects.toThrow('Permission denied');
    const controller = new AbortController();
    controller.abort(new Error('cancelled fixture'));
    await expect(registry.invoke('local.write_file', { ...input, path: 'cancel.txt' },
      { ...grants, operationId: 'cancelled', signal: controller.signal })).rejects.toThrow('cancelled fixture');
    await expect(stat(join(workspace, 'cancel.txt'))).rejects.toThrow();
  }));

test('journal rejects missing, corrupted and truncated evidence without recreating a destination', async () => {
  const faults = ['missing intent', 'corrupt intent', 'truncated marker', 'missing stage', 'modified file', 'replaced inode'] as const;
  for (const fault of faults) {
    await fixture(async (workspace, journal, registry) => {
      const invoke = () => registry.invoke('local.write_file', input, grants);
      await invoke();
      const directory = join(journal, createHash('sha256').update(grants.operationId).digest('hex'));
      const file = join(workspace, input.path);
      switch (fault) {
        case 'missing intent': await unlink(join(directory, 'intent.json')); break;
        case 'corrupt intent': await writeFile(join(directory, 'intent.json'), '{'); break;
        case 'truncated marker': await writeFile(join(directory, 'completed'), ''); break;
        case 'missing stage': await unlink(join(directory, 'staged')); break;
        case 'modified file': await writeFile(file, 'changed!'); break;
        case 'replaced inode': await unlink(file); await writeFile(file, input.content); break;
      }
      await expect(invoke()).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(fault === 'modified file' ? 'changed!' : input.content);
    });
  }
});

test('journal distinguishes an unpublished intent from ambiguous loss after the publishing claim', () =>
  fixture(async (workspace, journal, registry) => {
    const file = join(workspace, input.path);
    const directory = join(journal, createHash('sha256').update(grants.operationId).digest('hex'));
    const invoke = () => registry.invoke('local.write_file', input, grants);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'intent.json'), JSON.stringify({
      destination: file, contentHash: createHash('sha256').update(input.content).digest('hex'), version: 2,
    }));
    await writeFile(join(directory, 'intent.json.interrupted.tmp'), 'truncated temporary record');
    await invoke();
    await expect(registry.invoke('local.write_file', input, { ...grants, operationId: 'different' })).rejects.toThrow('another operation');
    await unlink(join(directory, 'completed'));
    await unlink(file);
    await expect(invoke()).rejects.toThrow('destination is missing');
    await expect(stat(file)).rejects.toThrow();
  }));

test('journal rejects parent symlinks outside the workspace and missing operation IDs', () =>
  fixture(async (workspace, journal, registry) => {
    await mkdir(journal);
    await symlink(journal, join(workspace, 'outside'), 'junction');
    await expect(registry.invoke('local.write_file', { ...input, path: 'outside/effect.txt' }, grants)).rejects.toThrow('escapes workspace');
    const { operationId: _operationId, ...withoutId } = grants;
    await expect(registry.invoke('local.write_file', input, withoutId)).rejects.toThrow('Operation ID is required');
    await expect(stat(join(journal, 'effect.txt'))).rejects.toThrow();
  }));
