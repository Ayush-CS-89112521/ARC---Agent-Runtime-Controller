import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hasCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException).code === code;

/** Write and sync a private file before publishing it to an exclusively claimed name. */
async function publishRecord(path: string, content: string): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return await link(temporary, path).then(() => true, error => {
      if (!hasCode(error, 'EEXIST')) throw error;
      return false;
    });
  } finally {
    await unlink(temporary);
  }
}

/**
 * The private staged inode is the ownership proof. A destination with identical
 * bytes but a different inode belongs to another operation.
 */
export async function publishJournaledWrite(
  journal: string, operationId: string, destination: string, content: string, signal: AbortSignal,
): Promise<void> {
  const directory = join(journal, digest(operationId));
  const intentPath = join(directory, 'intent.json');
  const stagedPath = join(directory, 'staged');
  const completedPath = join(directory, 'completed');
  const contentHash = digest(content);
  const legacyIntent = JSON.stringify({ destination, contentHash });
  const intent = JSON.stringify({ destination, contentHash, version: 2 });
  const publishingPath = join(directory, 'publishing');
  const inspect = (path: string) => lstat(path, { bigint: true }).catch(error => {
    if (!hasCode(error, 'ENOENT')) throw error;
    return undefined;
  });
  const record = async (path: string) => {
    const info = await inspect(path);
    if (!info) return undefined;
    if (!info.isFile() || info.size > 65536n) throw new Error('Write needs reconciliation: invalid journal record');
    return readFile(path, 'utf8');
  };
  signal.throwIfAborted();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await inspect(directory))?.isDirectory()) throw new Error('Write needs reconciliation: invalid journal directory');

  let existingIntent = await record(intentPath);
  if (existingIntent === undefined) {
    if (await inspect(stagedPath) || await inspect(completedPath) || await inspect(publishingPath)) {
      existingIntent = await record(intentPath);
      if (existingIntent === undefined) throw new Error('Write needs reconciliation: intent is missing');
    } else {
      await publishRecord(intentPath, intent);
      existingIntent = await record(intentPath);
    }
  }
  if (existingIntent !== intent && existingIntent !== legacyIntent) throw new Error('Operation ID conflicts with an existing write intent');

  const completed = await record(completedPath);
  const publishing = await record(publishingPath);
  if ((completed !== undefined && completed !== 'completed') || (publishing !== undefined && publishing !== 'publishing')) {
    throw new Error('Write needs reconciliation: corrupt publication marker');
  }

  let staged = await inspect(stagedPath);
  let target = await inspect(destination);
  if (!staged) {
    if (target || completed || publishing) {
      staged = await inspect(stagedPath);
      if (!staged) throw new Error('Write needs reconciliation: staged file is missing or destination belongs to another operation');
    } else {
      await publishRecord(stagedPath, content);
      staged = await inspect(stagedPath);
    }
  }
  if (!staged?.isFile() || staged.ino === 0n || staged.size !== BigInt(Buffer.byteLength(content))
      || digest(await readFile(stagedPath)) !== contentHash) {
    throw new Error('Write needs reconciliation: staged content changed');
  }
  if (!target && !completed && existingIntent === legacyIntent) {
    throw new Error('Write needs reconciliation: legacy destination is missing');
  }
  if (!target && !completed) {
    signal.throwIfAborted();
    if (!publishing && await publishRecord(publishingPath, 'publishing')) {
      await link(stagedPath, destination).catch(error => {
        if (!hasCode(error, 'EEXIST')) throw error;
      });
    } else {
      // A concurrent publisher may be between recording its claim and linking.
      for (let attempt = 0; attempt < 10 && !target; attempt++) {
        await delay(25, undefined, { signal });
        target = await inspect(destination);
      }
    }
    target ??= await inspect(destination);
  }
  if (!target) throw new Error('Write needs reconciliation: destination is missing');
  if (!target.isFile() || staged.dev !== target.dev || staged.ino !== target.ino
      || digest(await readFile(destination)) !== contentHash) {
    throw new Error('Write needs reconciliation: destination belongs to another operation or has changed');
  }
  if (!completed) await publishRecord(completedPath, 'completed');
}
