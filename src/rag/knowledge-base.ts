/**
 * RAG Knowledge Base Engine
 * 
 * Provides an intelligent persistence layer for workflow context retrieval.
 * Features:
 * - PostgreSQL with pgvector and an in-memory connection fallback.
 * - Semantic search: Vector-based similarity matching for error recovery and tool discovery.
 * - Ranked retrieval within a corpus and embedding model.
 */

import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { getLocalEmbeddingProvider, type EmbeddingProvider } from './local-embedding.js';
import { z } from 'zod';
import { maskGenericSecrets } from '../safety/secret-masker.js';
import type { WorkflowExecutionResult } from '../types/index.js';

export interface KnowledgeEntry {
    id: string;
    content: string;
    embedding: number[];
    metadata: {
        type: 'workflow' | 'error' | 'documentation' | 'tool' | 'web-scraped';
        source: string;
        timestamp: Date;
        tags: string[];
        confidence?: number;
        success?: boolean;
        chunk?: number;
        documentId?: string;
        corpus?: string;
        embeddingModel?: string;
    };
}

export interface QueryResult {
    content: string;
    similarity: number;
    metadata: KnowledgeEntry['metadata'];
}

/** Keep retrieved text and its attribution together when passing it to a planner. */
export function assembleRetrievedContext(results: readonly QueryResult[]): string {
    if (results.length === 0) return '';
    return JSON.stringify(results.slice(0, 3).map((result, index) => ({
        citation: index + 1,
        source: maskGenericSecrets(result.metadata.source).masked,
        documentId: result.metadata.documentId,
        corpus: result.metadata.corpus,
        embeddingModel: result.metadata.embeddingModel,
        chunk: result.metadata.chunk,
        content: maskGenericSecrets(result.content).masked.slice(0, 600),
    })));
}

const label = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/);
const metadataSchema = z.object({
    type: z.enum(['workflow', 'error', 'documentation', 'tool', 'web-scraped']),
    source: z.string().min(1).max(512).refine(source => !/[\x00-\x1f\x7f]/.test(source)),
    timestamp: z.date(),
    tags: z.array(z.string().min(1).max(128).refine(tag => !/[\x00-\x1f\x7f]/.test(tag))).max(64),
    confidence: z.number().min(0).max(1).optional(),
    success: z.boolean().optional(),
});
const MAX_DOCUMENT_BYTES = 128 * 1024;
const MAX_QUERY_BYTES = 16 * 1024;

export interface KnowledgeBaseOptions {
    corpus?: string;
    embedding?: { id: string; generate: (text: string) => Promise<number[]> };
}

export class KnowledgeBase {
    private client: Client;
    private isMemoryMode = false;
    private memoryEntries = new Map<string, KnowledgeEntry>();
    private readonly corpus: string;
    private readonly getEmbedding: () => Promise<EmbeddingProvider>;

    constructor(connectionString?: string, options: KnowledgeBaseOptions = {}) {
        this.client = new Client({
            connectionString: connectionString || process.env.DATABASE_URL || 'postgresql://localhost:5432/arc_knowledge',
            connectionTimeoutMillis: 3000,
        });
        this.corpus = label.parse(options.corpus ?? 'default');
        const configuredPath = process.env.ARC_LOCAL_EMBEDDING_PATH;
        const supplied = options.embedding;
        if (supplied) {
            const provider = { id: label.parse(supplied.id), generate: supplied.generate.bind(supplied) };
            this.getEmbedding = async () => provider;
        } else {
            this.getEmbedding = () => getLocalEmbeddingProvider(configuredPath);
        }
    }

    async connect(): Promise<void> {
        try {
            await this.client.connect();
            await this.ensureSchema();
            this.isMemoryMode = false;
            console.log('✅ Connected to PostgreSQL Knowledge Base');
        } catch {
            await this.client.end().catch(() => undefined);
            this.isMemoryMode = true;
            console.warn('⚠️ PostgreSQL unavailable, falling back to In-Memory Mode');
        }
    }

    get storageMode(): 'postgres' | 'memory' { return this.isMemoryMode ? 'memory' : 'postgres'; }

    async disconnect(): Promise<void> {
        if (!this.isMemoryMode) {
            await this.client.end();
        }
    }

    private async ensureSchema(): Promise<void> {
        if (this.isMemoryMode) return;
        // Create extension if not exists
        await this.client.query('CREATE EXTENSION IF NOT EXISTS vector;');

        // Create table if not exists
        await this.client.query(`
      CREATE TABLE IF NOT EXISTS knowledge_base (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        content TEXT NOT NULL,
        embedding vector(384),
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    }

    private async ingest(content: string, metadata: KnowledgeEntry['metadata']): Promise<void> {
        if (typeof content !== 'string' || !content.trim() || content.includes('\0') || typeof metadata.source !== 'string' || !metadata.source.trim()) {
            throw new Error('Document content and source are required as plain text');
        }
        if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds the 128 KiB ingestion limit');
        metadataSchema.parse(metadata);
        const provider = await this.getEmbedding();
        const documentId = createHash('sha256')
            .update(JSON.stringify([this.corpus, provider.id, metadata.type, metadata.source, metadata.tags, content.trim()]))
            .digest('hex');
        const characters = Array.from(content.trim());
        const chunks: Array<{ id: string; content: string; embedding: number[]; metadata: KnowledgeEntry['metadata'] }> = [];
        for (let offset = 0; offset < characters.length; offset += 1000) {
            const chunk = offset / 1000;
            const text = characters.slice(offset, offset + 1000).join('');
            if (!text.trim()) continue;
            const key = JSON.stringify([documentId, chunk]);
            const hash = createHash('sha256').update(key).digest('hex');
            const id = [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20, 32)].join('-');
            chunks.push({ id, content: text, embedding: await this.generateEmbedding(text, provider), metadata: { ...metadata, chunk, documentId, corpus: this.corpus, embeddingModel: provider.id } });
        }
        if (this.isMemoryMode) {
            for (const chunk of chunks) if (!this.memoryEntries.has(chunk.id)) this.memoryEntries.set(chunk.id, chunk);
            return;
        }
        await this.client.query(`
            INSERT INTO knowledge_base (id, content, embedding, metadata)
            SELECT id, content, embedding::text::vector, metadata
            FROM jsonb_to_recordset($1::jsonb) AS entries(id uuid, content text, embedding jsonb, metadata jsonb)
            ON CONFLICT (id) DO NOTHING
        `, [JSON.stringify(chunks)]);
    }

    /**
     * Add a workflow execution to the knowledge base
     */
    async addWorkflow(
        workflowName: string,
        result: WorkflowExecutionResult,
        additionalContext?: string
    ): Promise<void> {
        const content = this.formatWorkflowContent(workflowName, result, additionalContext);
        const metadata = {
            type: 'workflow' as const,
            source: workflowName,
            timestamp: new Date(),
            tags: this.extractTags(workflowName, result),
            success: result.success,
            confidence: (result.stats?.successfulSteps ?? 0) / Math.max(1, result.stats?.totalSteps ?? 1)
        };

        await this.ingest(content, metadata);
    }

    /**
     * Add error resolution to the knowledge base
     */
    async addErrorResolution(
        error: string,
        resolution: string,
        context?: string
    ): Promise<void> {
        const content = `Error: ${error}\nResolution: ${resolution}\nContext: ${context || 'N/A'}`;
        const metadata = {
            type: 'error' as const,
            source: 'error-resolution',
            timestamp: new Date(),
            tags: ['error', 'resolution'],
            confidence: 0.9
        };

        await this.ingest(content, metadata);
    }

    /**
     * Add web-scraped documentation to the knowledge base
     */
    async addWebScrapedDocs(
        url: string,
        topic: string,
        content: string
    ): Promise<void> {
        const metadata = {
            type: 'web-scraped' as const,
            source: url,
            timestamp: new Date(),
            tags: [topic, 'documentation', 'web-scraped'],
            confidence: 0.85
        };

        await this.ingest(content, metadata);
    }

    /**
     * Query the knowledge base for relevant context
     */
    async queryContext(
        query: string,
        options: {
            limit?: number;
            threshold?: number;
            type?: KnowledgeEntry['metadata']['type'];
        } = {}
    ): Promise<QueryResult[]> {
        const { limit = 5, threshold = 0.7, type } = options;

        if (typeof query !== 'string' || !query.trim() || query.includes('\0') || Buffer.byteLength(query) > MAX_QUERY_BYTES
            || !Number.isSafeInteger(limit) || limit < 0 || limit > 100 || !Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
            throw new Error('Invalid retrieval query, limit, or threshold');
        }
        if (limit === 0) return [];

        // Generate query embedding
        const provider = await this.getEmbedding();
        const queryEmbedding = await this.generateEmbedding(query, provider);

        if (this.isMemoryMode) {
            return this.matchDocumentsInMemory(queryEmbedding, threshold, limit, type);
        }

        // Older databases can still have an approximate IVFFlat index. Score the
        // scoped rows before sorting so that index cannot omit eligible documents.
        const result = await this.client.query<QueryResult>(`
            WITH scoped AS MATERIALIZED (
                SELECT id, content, metadata, embedding
                FROM knowledge_base
                WHERE metadata->>'corpus' = $4 AND metadata->>'embeddingModel' = $5
                    AND ($6::text IS NULL OR metadata->>'type' = $6)
            )
            SELECT content, metadata, 1 - (embedding <=> $1::vector) AS similarity
            FROM scoped
            WHERE 1 - (embedding <=> $1::vector) >= $2
            ORDER BY embedding <=> $1::vector, id
            LIMIT $3
        `, [JSON.stringify(queryEmbedding), threshold, limit, this.corpus, provider.id, type ?? null]);
        return result.rows.map(({ content, similarity, metadata }) => ({
            content, similarity, metadata: { ...metadata, timestamp: new Date(metadata.timestamp) },
        }));
    }

    /**
     * Match documents using in-memory cosine similarity
     */
    private matchDocumentsInMemory(
        queryEmbedding: number[],
        threshold: number,
        limit: number,
        type?: KnowledgeEntry['metadata']['type']
    ): QueryResult[] {
        let entries = Array.from(this.memoryEntries.values());
        if (type) {
            entries = entries.filter(e => e.metadata.type === type);
        }

        return entries
            .map(entry => ({
                content: entry.content,
                metadata: entry.metadata,
                similarity: this.cosineSimilarity(queryEmbedding, entry.embedding)
            }))
            .filter(r => r.similarity >= threshold)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);
    }

    /**
     * Compute cosine similarity between two vectors
     */
    private cosineSimilarity(v1: number[], v2: number[]): number {
        let dotProduct = 0;
        let mag1 = 0;
        let mag2 = 0;
        for (let i = 0; i < v1.length; i++) {
            dotProduct += v1[i] * v2[i];
            mag1 += v1[i] * v1[i];
            mag2 += v2[i] * v2[i];
        }
        return dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2) || 1);
    }

    private async generateEmbedding(text: string, provider: EmbeddingProvider): Promise<number[]> {
        const generated = await provider.generate(text);
        const vector = Array.isArray(generated)
            ? Array.from(generated, value => typeof value === 'number' ? Math.fround(value) : NaN)
            : [];
        if (vector.length !== 384 || !vector.every(Number.isFinite) || !vector.some(value => value !== 0)) {
            throw new Error('Expected a nonzero embedding with 384 finite dimensions');
        }
        return vector;
    }

    /**
     * Format workflow content for storage
     */
    private formatWorkflowContent(
        workflowName: string,
        result: WorkflowExecutionResult,
        additionalContext?: string
    ): string {
        const parts = [
            `Workflow: ${workflowName}`,
            `Success: ${result.success}`,
            `Steps: ${result.stats?.totalSteps || 0}`,
            `Duration: ${result.executionTime || 0}ms`
        ];

        if (result.summary) {
            parts.push(`Summary: ${result.summary}`);
        }

        if (additionalContext) {
            parts.push(`Context: ${additionalContext}`);
        }

        if (result.errors && result.errors.length > 0) {
            parts.push(`Errors: ${result.errors.map(e => e.message).join(', ')}`);
        }

        return parts.join('\n');
    }

    /**
     * Extract tags from workflow name and result
     */
    private extractTags(workflowName: string, result: WorkflowExecutionResult): string[] {
        const tags = ['workflow'];

        // Add success/failure tag
        tags.push(result.success ? 'success' : 'failure');

        // Extract keywords from workflow name
        const keywords = workflowName.toLowerCase().match(/\b\w+\b/g) || [];
        tags.push(...keywords.filter(k => k.length > 3));

        // Add step count category
        const stepCount = result.stats?.totalSteps || 0;
        if (stepCount <= 3) tags.push('simple');
        else if (stepCount <= 10) tags.push('medium');
        else tags.push('complex');

        return [...new Set(tags)]; // Remove duplicates
    }

    /**
     * Get statistics about the knowledge base
     */
    async getStats(): Promise<{
        totalEntries: number;
        byType: Record<string, number>;
        successRate: number;
    }> {
        if (this.isMemoryMode) {
            const byType: Record<string, number> = {};
            let successCount = 0;
            for (const entry of this.memoryEntries.values()) {
                const type = entry.metadata.type;
                byType[type] = (byType[type] || 0) + 1;
                if (entry.metadata.success) successCount++;
            }
            return {
                totalEntries: this.memoryEntries.size,
                byType,
                successRate: this.memoryEntries.size > 0 ? successCount / this.memoryEntries.size : 0
            };
        }

        const scope = "metadata->>'corpus' = $1 AND metadata->>'embeddingModel' = $2";
        const provider = await this.getEmbedding();
        const parameters = [this.corpus, provider.id];
        const totalResult = await this.client.query(`SELECT COUNT(*) FROM knowledge_base WHERE ${scope}`, parameters);
        const total = parseInt(totalResult.rows[0].count);

        const typeResult = await this.client.query(`
      SELECT metadata->>'type' as type, COUNT(*) as count
      FROM knowledge_base
      WHERE ${scope}
      GROUP BY metadata->>'type'
    `, parameters);

        const byType: Record<string, number> = {};
        typeResult.rows.forEach((row: any) => {
            byType[row.type] = parseInt(row.count);
        });

        const successResult = await this.client.query(`
      SELECT COUNT(*) as count
      FROM knowledge_base
      WHERE ${scope} AND metadata->>'success' = 'true'
    `, parameters);
        const successCount = parseInt(successResult.rows[0].count);

        return {
            totalEntries: total,
            byType,
            successRate: total > 0 ? successCount / total : 0
        };
    }
}
