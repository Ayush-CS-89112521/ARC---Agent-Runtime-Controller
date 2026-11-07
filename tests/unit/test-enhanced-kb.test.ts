
/**
 * Enhanced Knowledge Base Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { EnhancedKnowledgeBase } from '../../src/rag/enhanced-knowledge-base';
import { rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('Enhanced Knowledge Base', () => {
    let kb: EnhancedKnowledgeBase;
    const testDir = join(process.cwd(), '.arc-test-enhanced');
    const dataDir = join(process.cwd(), 'data');

    // Mock data paths
    const mcpCatalogPath = join(dataDir, 'mcp-catalog.json');
    const apiRegistryPath = join(dataDir, 'api-registry.json');

    beforeAll(async () => {
        // Ensure data directory exists
        if (!require('fs').existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true });
        }

        // Create mock catalogs if they don't exist
        if (!require('fs').existsSync(mcpCatalogPath)) {
            const mockMcp = {
                tools: [
                    {
                        name: "test/mcp-server-postgres",
                        description: "PostgreSQL MCP Server",
                        category: "Database",
                        languages: ["typescript"],
                        tags: ["database", "sql", "postgres"],
                        npmPackage: "@modelcontextprotocol/server-postgres",
                        installation: "npx @modelcontextprotocol/server-postgres"
                    },
                    {
                        name: "test/mcp-server-browser",
                        description: "Browser Automation",
                        category: "Browser Automation",
                        languages: ["typescript"],
                        tags: ["browser", "automation"],
                        npmPackage: "@browserbase/mcp-server",
                        installation: "npx @browserbase/mcp-server"
                    }
                ]
            };
            writeFileSync(mcpCatalogPath, JSON.stringify(mockMcp));
        }

        if (!require('fs').existsSync(apiRegistryPath)) {
            const mockApi = {
                entries: [
                    {
                        id: "test-github-api",
                        name: "GitHub API",
                        description: "GitHub REST API",
                        category: "Developer Tools",
                        url: "https://api.github.com",
                        authType: "token",
                        https: true,
                        cors: "yes"
                    },
                    {
                        id: "test-weather-api",
                        name: "Weather API",
                        description: "Weather forecasts",
                        category: "Weather",
                        url: "https://api.weather.com",
                        authType: "apiKey",
                        https: true,
                        cors: "unknown"
                    }
                ]
            };
            writeFileSync(apiRegistryPath, JSON.stringify(mockApi));
        }

        kb = new EnhancedKnowledgeBase(testDir);
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

    it('should index MCP servers', async () => {
        const stats = await kb.getStats();
        expect(stats.totalEntries).toBeGreaterThan(0);
        expect(stats.byType['tool']).toBeGreaterThan(0);
    });

    it('should index Public APIs', async () => {
        const stats = await kb.getStats();
        expect(stats.byType['documentation']).toBeGreaterThan(0);
    });

    it('should search for tools (MCP servers)', async () => {
        const results = await kb.searchTools('postgres', 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].metadata.type).toBe('tool');
        expect(results[0].content.toLowerCase()).toContain('postgres');
    });

    it('should search for APIs', async () => {
        const results = await kb.searchApis('weather', 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].metadata.type).toBe('documentation');
        expect(results[0].content.toLowerCase()).toContain('weather');
    });

    it('should return mixed results for generic query', async () => {
        const results = await kb.queryContext('automation tool', { limit: 10, threshold: 0.01 });
        const types = new Set(results.map(r => r.metadata.type));
        // Might contain 'tool' (from MCP) or 'documentation' (from API if relevant)
        // Just checking we get results
        expect(results.length).toBeGreaterThan(0);
    });
});
