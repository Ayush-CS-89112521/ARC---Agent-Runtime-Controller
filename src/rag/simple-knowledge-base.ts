/**
 * Simple File-Based Knowledge Base
 * 
 * Fallback implementation when PostgreSQL is not available.
 * Uses JSON files for storage and simple text similarity.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { WorkflowExecutionResult } from '../types/index.js';

export interface KnowledgeEntry {
    id: string;
    content: string;
    metadata: {
        type: 'workflow' | 'error' | 'documentation' | 'tool' | 'web-scraped';
        source: string;
        timestamp: Date;
        tags: string[];
        confidence?: number;
        success?: boolean;
    };
}

export interface QueryResult {
    content: string;
    similarity: number;
    metadata: KnowledgeEntry['metadata'];
}

export class SimpleKnowledgeBase {
    private dataDir: string;
    protected entries: KnowledgeEntry[] = [];

    constructor(dataDir?: string) {
        this.dataDir = dataDir || join(process.cwd(), '.arc', 'knowledge');
    }

    async connect(): Promise<void> {
        // Ensure directory exists
        if (!existsSync(this.dataDir)) {
            await mkdir(this.dataDir, { recursive: true });
        }

        // Load existing entries
        await this.loadEntries();
    }

    async disconnect(): Promise<void> {
        // Save entries before disconnecting
        await this.saveEntries();
    }

    private async loadEntries(): Promise<void> {
        const filePath = join(this.dataDir, 'knowledge.json');

        if (existsSync(filePath)) {
            try {
                const data = await readFile(filePath, 'utf-8');
                this.entries = JSON.parse(data);
            } catch (error) {
                console.warn('Failed to load knowledge base:', error);
                this.entries = [];
            }
        }
    }

    private async saveEntries(): Promise<void> {
        const filePath = join(this.dataDir, 'knowledge.json');

        try {
            await writeFile(filePath, JSON.stringify(this.entries, null, 2));
        } catch (error) {
            console.error('Failed to save knowledge base:', error);
        }
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

        this.entries.push({
            id: `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            content,
            metadata: {
                type: 'workflow',
                source: workflowName,
                timestamp: new Date(),
                tags: this.extractTags(workflowName, result),
                success: result.success,
                confidence: (result.stats?.totalSteps && result.stats.totalSteps > 0)
                    ? (result.stats?.successfulSteps || 0) / result.stats.totalSteps
                    : 0
            }
        });

        await this.saveEntries();
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

        this.entries.push({
            id: `error-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            content,
            metadata: {
                type: 'error',
                source: 'error-resolution',
                timestamp: new Date(),
                tags: ['error', 'resolution'],
                confidence: 0.9
            }
        });

        await this.saveEntries();
    }

    /**
     * Add web-scraped documentation to the knowledge base
     */
    async addWebScrapedDocs(
        url: string,
        topic: string,
        content: string
    ): Promise<void> {
        this.entries.push({
            id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            content,
            metadata: {
                type: 'web-scraped',
                source: url,
                timestamp: new Date(),
                tags: [topic, 'documentation', 'web-scraped'],
                confidence: 0.85
            }
        });

        await this.saveEntries();
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
        const { limit = 5, threshold = 0.3, type } = options;

        // Filter by type if specified
        let entries = type
            ? this.entries.filter(e => e.metadata.type === type)
            : this.entries;

        // Calculate similarity scores
        const results = entries.map(entry => ({
            content: entry.content,
            similarity: this.calculateSimilarity(query, entry.content),
            metadata: entry.metadata
        }));

        // Filter by threshold and sort by similarity
        return results
            .filter(r => r.similarity >= threshold)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);
    }

    /**
     * Calculate simple text similarity (Jaccard similarity)
     */
    private calculateSimilarity(text1: string, text2: string): number {
        const words1 = new Set(text1.toLowerCase().match(/\b\w+\b/g) || []);
        const words2 = new Set(text2.toLowerCase().match(/\b\w+\b/g) || []);

        const intersection = new Set([...words1].filter(x => words2.has(x)));
        const union = new Set([...words1, ...words2]);

        return union.size > 0 ? intersection.size / union.size : 0;
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
        const byType: Record<string, number> = {};
        let successCount = 0;

        for (const entry of this.entries) {
            const type = entry.metadata.type;
            byType[type] = (byType[type] || 0) + 1;

            if (entry.metadata.success) {
                successCount++;
            }
        }

        return {
            totalEntries: this.entries.length,
            byType,
            successRate: this.entries.length > 0 ? successCount / this.entries.length : 0
        };
    }

    /**
     * Clear all entries
     */
    async clear(): Promise<void> {
        this.entries = [];
        await this.saveEntries();
    }
}
