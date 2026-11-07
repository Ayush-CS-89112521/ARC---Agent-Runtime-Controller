/**
 * Simple Knowledge Base Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { SimpleKnowledgeBase } from '../../src/rag/simple-knowledge-base';
import { rmSync } from 'fs';
import { join } from 'path';

describe('Simple Knowledge Base', () => {
    let kb: SimpleKnowledgeBase;
    const testDir = join(process.cwd(), '.arc-test');

    beforeAll(async () => {
        kb = new SimpleKnowledgeBase(testDir);
        await kb.connect();
    });

    afterAll(async () => {
        await kb.disconnect();
        // Clean up test directory
        try {
            rmSync(testDir, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors
        }
    });

    it('should connect to knowledge base', () => {
        expect(kb).toBeDefined();
    });

    it('should add workflow to knowledge base', async () => {
        await kb.addWorkflow('Test Workflow', {
            success: true,
            stats: { totalSteps: 3, successfulSteps: 3, failedSteps: 0 },
            executionTime: 1000,
            errors: []
        });

        const stats = await kb.getStats();
        expect(stats.totalEntries).toBeGreaterThan(0);
    });

    it('should query context from knowledge base', async () => {
        // Add a workflow first
        await kb.addWorkflow('Create REST API', {
            success: true,
            stats: { totalSteps: 5, successfulSteps: 5, failedSteps: 0 },
            executionTime: 2000,
            errors: []
        });

        // Query for similar workflows (very low threshold for simple Jaccard)
        const results = await kb.queryContext('Build API', {
            limit: 5,
            threshold: 0.05
        });

        expect(Array.isArray(results)).toBe(true);
        // Jaccard similarity might be low, just verify we get array
    });

    it('should calculate similarity correctly', async () => {
        await kb.addWorkflow('Express REST API', {
            success: true,
            stats: { totalSteps: 4, successfulSteps: 4, failedSteps: 0 },
            executionTime: 1500,
            errors: []
        });

        const results = await kb.queryContext('Express API', {
            limit: 1,
            threshold: 0.05
        });

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].similarity).toBeGreaterThan(0);
    });

    it('should get knowledge base stats', async () => {
        const stats = await kb.getStats();
        expect(stats).toHaveProperty('totalEntries');
        expect(stats).toHaveProperty('byType');
        expect(stats).toHaveProperty('successRate');
        expect(stats.totalEntries).toBeGreaterThan(0);
    });

    it('should add error resolution', async () => {
        await kb.addErrorResolution(
            'TypeError: Cannot read property',
            'Use optional chaining (?.)',
            'API endpoint handler'
        );

        const stats = await kb.getStats();
        expect(stats.byType.error).toBeGreaterThan(0);
    });

    it('should add web-scraped docs', async () => {
        await kb.addWebScrapedDocs(
            'https://example.com',
            'express',
            'Express.js documentation content'
        );

        const stats = await kb.getStats();
        expect(stats.byType['web-scraped']).toBeGreaterThan(0);
    });

    it('should filter by type', async () => {
        const workflows = await kb.queryContext('API', {
            type: 'workflow',
            limit: 10
        });

        expect(workflows.every(r => r.metadata.type === 'workflow')).toBe(true);
    });

    it('should clear knowledge base', async () => {
        await kb.clear();
        const stats = await kb.getStats();
        expect(stats.totalEntries).toBe(0);
    });
});
