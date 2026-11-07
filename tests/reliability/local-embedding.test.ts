import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLocalEmbeddingProvider } from '../../src/rag/local-embedding';
import { writeSyntheticModel } from '../fixtures/synthetic-embedding-model';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'arc-embed-'));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('native synthetic ONNX validates tokenizer, dimensions, pooling and repeatability', () =>
  fixture(async root => {
    await writeSyntheticModel(root);
    const load = getLocalEmbeddingProvider(root);
    expect(getLocalEmbeddingProvider(root)).toBe(load);
    const provider = await load;
    const [apple, pear, appleAgain] = await Promise.all(['apple', 'pear', 'apple'].map(text => provider.generate(text)));
    expect(apple).toHaveLength(384);
    expect(apple.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...apple)).toBeCloseTo(1, 6);
    expect(apple).toEqual(appleAgain);
    expect(apple[4]).toBeGreaterThan(0);
    expect(pear[4]).toBe(0);
    expect(apple[2]).toBeCloseTo(apple[4]!, 6);
    await expect(provider.generate(' ')).rejects.toThrow('Invalid local embedding input');
    await expect(provider.generate('x'.repeat(16385))).rejects.toThrow('Invalid local embedding input');
    await expect(provider.generate('apple\0pear')).rejects.toThrow('Invalid local embedding input');
  }), 15000);

test('invalid configuration, tokenizer and graph fail explicitly and initialization can retry', () =>
  fixture(async root => {
    await expect(getLocalEmbeddingProvider(undefined)).rejects.toThrow('ARC_LOCAL_EMBEDDING_PATH');
    await expect(getLocalEmbeddingProvider(root)).rejects.toThrow('Local embedding initialization failed');
    await writeSyntheticModel(root);
    const config = join(root, 'config.json');
    await writeFile(config, '{}');
    await expect(getLocalEmbeddingProvider(root)).rejects.toThrow('Local embedding initialization failed');
    await writeSyntheticModel(root);
    await writeFile(join(root, 'tokenizer.json'), '{');
    await expect(getLocalEmbeddingProvider(root)).rejects.toThrow('Local embedding initialization failed');
    await writeSyntheticModel(root);
    await writeFile(join(root, 'onnx', 'model_quantized.onnx'), 'invalid ONNX');
    await expect(getLocalEmbeddingProvider(root)).rejects.toThrow('Local embedding initialization failed');
    await writeSyntheticModel(root);
    expect(await (await getLocalEmbeddingProvider(root)).generate('apple')).toHaveLength(384);
  }), 15000);

test('artifact junctions are refused and valid graphs with incompatible width are rejected', () =>
  fixture(async root => {
    const external = join(root, 'outside');
    const model = join(root, 'model');
    await writeSyntheticModel(external, 8);
    await writeSyntheticModel(model);
    await rm(join(model, 'onnx'), { recursive: true });
    await symlink(join(external, 'onnx'), join(model, 'onnx'), 'junction');
    await expect(getLocalEmbeddingProvider(model)).rejects.toThrow('Local embedding initialization failed');
    const provider = await getLocalEmbeddingProvider(external);
    await expect(provider.generate('apple')).rejects.toThrow('shape [1, 384]');
  }), 15000);

test('bundle identity follows artifact content independently of the directory name', () =>
  fixture(async root => {
    const a = join(root, 'a');
    const b = join(root, 'b');
    const c = join(root, 'c');
    await mkdir(root, { recursive: true });
    await Promise.all([writeSyntheticModel(a), writeSyntheticModel(b), writeSyntheticModel(c)]);
    await writeFile(join(c, 'tokenizer_config.json'), JSON.stringify({ tokenizer_class: 'BertTokenizer', model_max_length: 256 }));
    const [first, copied, changed] = await Promise.all([a, b, c].map(getLocalEmbeddingProvider));
    expect(first.id).toBe(copied.id);
    expect(first.id).not.toBe(changed.id);
  }), 15000);
