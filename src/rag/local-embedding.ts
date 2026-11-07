import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';

export interface EmbeddingProvider {
    id: string;
    generate(text: string): Promise<number[]>;
}

const modelFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'] as const;
const extractors = new Map<string, Promise<EmbeddingProvider>>();
const modelConfig = z.object({ model_type: z.literal('bert'), hidden_size: z.literal(384) });
const tokenizerConfig = z.object({ tokenizer_class: z.string().min(1).optional() });
const tokenizer = z.object({ model: z.object({ type: z.literal('WordPiece'), vocab: z.record(z.string(), z.number().int().nonnegative()) }) });

async function loadModel(directory: string): Promise<EmbeddingProvider> {
    const root = await realpath(directory);
    const fingerprint = createHash('sha256').update('transformers-4.3.2:cpu:bert:q8:mean:l2\n');
    const configs = new Map<string, unknown>();
    for (const name of modelFiles) {
        const file = join(root, name);
        const info = await stat(file);
        if (relative(file, await realpath(file)) || !info.isFile()) {
            throw new Error(`Invalid local embedding artifact path: ${name}`);
        }
        const isConfig = name.endsWith('.json');
        const maxBytes = isConfig ? 16 * 1024 * 1024 : 256 * 1024 * 1024;
        if (!info.size || info.size > maxBytes) throw new Error(`Invalid local embedding artifact size: ${name}`);
        const hash = createHash('sha256');
        if (isConfig) {
            const bytes = await readFile(file);
            hash.update(bytes);
            try { configs.set(name, JSON.parse(bytes.toString('utf8'))); }
            catch { throw new Error(`Invalid local embedding JSON: ${name}`); }
        } else {
            for await (const chunk of createReadStream(file)) hash.update(chunk);
        }
        fingerprint.update(`${name}:${hash.digest('hex')}\n`);
    }
    modelConfig.parse(configs.get('config.json'));
    tokenizer.parse(configs.get('tokenizer.json'));
    tokenizerConfig.parse(configs.get('tokenizer_config.json'));

    const { AutoModel, AutoTokenizer, FeatureExtractionPipeline, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = false;
    env.useFSCache = false;
    env.useBrowserCache = false;
    env.useCustomCache = false;
    const loadedTokenizer = await AutoTokenizer.from_pretrained(root, { local_files_only: true });
    const model = await AutoModel.from_pretrained(root, {
        local_files_only: true,
        device: 'cpu',
        dtype: 'q8',
        use_external_data_format: false,
    });
    const extract = new FeatureExtractionPipeline({ task: 'feature-extraction', tokenizer: loadedTokenizer, model });
    return {
        id: `bert384-v4:${fingerprint.digest('hex')}`,
        async generate(text) {
            if (typeof text !== 'string' || !text.trim() || text.includes('\0') || Buffer.byteLength(text) > 16 * 1024) {
                throw new Error('Invalid local embedding input');
            }
            const tensor = await extract(text, { pooling: 'mean', normalize: true });
            if (tensor.dims.length !== 2 || tensor.dims[0] !== 1 || tensor.dims[1] !== 384 || !(tensor.data instanceof Float32Array)) {
                throw new Error('Expected a float32 embedding tensor with shape [1, 384]');
            }
            const vector = Array.from(tensor.data);
            const norm = Math.hypot(...vector);
            if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) throw new Error('Expected a finite unit-length local embedding');
            return vector;
        },
    };
}

/** Coalesce initialization per configured directory. Failures may be retried. */
export function getLocalEmbeddingProvider(modelPath: string | undefined): Promise<EmbeddingProvider> {
    if (!modelPath?.trim()) return Promise.reject(new Error('Set ARC_LOCAL_EMBEDDING_PATH to an existing local model directory'));
    const path = resolve(modelPath);
    let extractor = extractors.get(path);
    if (!extractor) {
        extractor = loadModel(path).catch(error => {
            extractors.delete(path);
            throw new Error('Local embedding initialization failed', { cause: error });
        });
        extractors.set(path, extractor);
    }
    return extractor;
}
