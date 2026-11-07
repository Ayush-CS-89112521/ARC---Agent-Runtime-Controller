import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { publishJournaledWrite } from './local-write-journal.js';
import { z } from 'zod';
import { ExecutableRegistry } from './executable-registry.js';

/** A small real local adapter set; no arbitrary command runner is registered. */
export function registerLocalTools(registry: ExecutableRegistry, workspace: string, writeJournal?: string): ExecutableRegistry {
  const root = path.resolve(workspace);
  const within = (base: string, target: string) => {
    const relative = path.relative(base, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path escapes workspace');
  };
  const resolvePath = async (file: string, write: boolean) => {
    const target = path.resolve(root, file);
    within(root, target);
    const actualRoot = await realpath(root);
    const resolved = await realpath(write ? path.dirname(target) : target);
    within(actualRoot, resolved);
    return write ? path.join(resolved, path.basename(target)) : resolved;
  };
  const readInput = z.object({ path: z.string().min(1) }).strict();
  const writeInput = z.object({ path: z.string().min(1), content: z.string().max(1024 * 1024) }).strict();
  registry.register({ id: 'local.read_file', name: 'Read workspace file',
    description: 'Read a UTF-8 file. input: {path: string}', permission: 'files.read', requiresApproval: false,
    input: readInput, output: z.object({ content: z.string() }).strict(),
    execute: async (raw, context) => {
      const input = readInput.parse(raw);
      const target = await resolvePath(input.path, false);
      context.signal.throwIfAborted();
      return { content: await readFile(target, { encoding: 'utf8', signal: context.signal }) };
    },
  });
  return registry.register({ id: 'local.write_file', name: 'Create workspace file',
    description: 'Create a new UTF-8 file, never overwrite. input: {path: string, content: string}',
    permission: 'files.write', requiresApproval: true, input: writeInput,
    output: z.object({ path: z.string(), created: z.literal(true) }).strict(),
    execute: async (raw, context) => {
      const input = writeInput.parse(raw);
      const target = await resolvePath(input.path, true);
      context.signal.throwIfAborted();
      if (writeJournal) {
        if (!context.operationId) throw new Error('Operation ID is required for a journaled write');
        await publishJournaledWrite(writeJournal, context.operationId, target, input.content, context.signal);
      } else {
        await writeFile(target, input.content, { encoding: 'utf8', flag: 'wx', signal: context.signal });
      }
      return { path: input.path, created: true };
    },
  });
}
