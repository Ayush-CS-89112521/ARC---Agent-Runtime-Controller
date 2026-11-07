/**
 * MCP Servers Catalog Parser
 * 
 * Parses the Awesome MCP Servers README.md and generates a structured catalog
 * for tool discovery and integration.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

interface MCPServer {
    id: string;
    name: string;
    githubUrl: string;
    description: string;
    category: string;
    language: 'typescript' | 'python' | 'go' | 'rust' | 'csharp' | 'java' | 'cpp' | 'ruby' | 'other';
    platforms: ('cloud' | 'local' | 'embedded')[];
    os: ('mac' | 'windows' | 'linux')[];
    official: boolean;
    npmPackage?: string;
    tags: string[];
}

interface MCPCatalog {
    version: string;
    lastUpdated: string;
    totalServers: number;
    servers: MCPServer[];
    categories: Record<string, number>;
    languages: Record<string, number>;
}

class MCPCatalogParser {
    private readme: string;
    private servers: MCPServer[] = [];
    private currentCategory: string = '';

    constructor(readmePath: string) {
        this.readme = readFileSync(readmePath, 'utf-8');
    }

    /**
     * Parse the README and extract all MCP servers
     */
    parse(): MCPCatalog {
        const lines = this.readme.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Detect category headers
            if (line.startsWith('### ') && line.includes('<a name=')) {
                this.currentCategory = this.extractCategory(line);
                continue;
            }

            // Parse server entries (lines starting with "- [")
            if (line.startsWith('- [') && line.includes('](')) {
                const server = this.parseServerEntry(line);
                if (server) {
                    this.servers.push(server);
                }
            }
        }

        return this.buildCatalog();
    }

    /**
     * Extract category name from header
     */
    private extractCategory(line: string): string {
        // Example: ### 🔗 <a name="aggregators"></a>Aggregators
        const match = line.match(/###.*?<\/a>(.+)/);
        return match ? match[1].trim() : 'Other';
    }

    /**
     * Parse a single server entry
     */
    private parseServerEntry(line: string): MCPServer | null {
        try {
            // Example: - [browserbase/mcp-server-browserbase](https://github.com/browserbase/mcp-server-browserbase) 🎖️ 📇 ☁️ - Description here

            // Extract name and URL
            const nameMatch = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
            if (!nameMatch) return null;

            const name = nameMatch[1];
            const githubUrl = nameMatch[2];

            // Extract description (after the last dash)
            const parts = line.split(' - ');
            const description = parts.length > 1 ? parts[parts.length - 1].trim() : '';

            // Extract metadata from emojis
            const official = line.includes('🎖️');
            const language = this.extractLanguage(line);
            const platforms = this.extractPlatforms(line);
            const os = this.extractOS(line);

            // Generate ID from name
            const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

            // Extract tags from description
            const tags = this.extractTags(description);

            // Try to extract npm package name
            const npmPackage = this.extractNpmPackage(line, description);

            return {
                id,
                name,
                githubUrl,
                description,
                category: this.currentCategory,
                language,
                platforms,
                os,
                official,
                ...(npmPackage ? { npmPackage } : {}),
                tags
            };
        } catch (error) {
            console.warn(`Failed to parse line: ${line}`, error);
            return null;
        }
    }

    /**
     * Extract programming language from emojis
     */
    private extractLanguage(line: string): MCPServer['language'] {
        if (line.includes('📇')) return 'typescript';
        if (line.includes('🐍')) return 'python';
        if (line.includes('🏎️')) return 'go';
        if (line.includes('🦀')) return 'rust';
        if (line.includes('#️⃣')) return 'csharp';
        if (line.includes('☕')) return 'java';
        if (line.includes('🌊')) return 'cpp';
        if (line.includes('💎')) return 'ruby';
        return 'other';
    }

    /**
     * Extract platforms from emojis
     */
    private extractPlatforms(line: string): MCPServer['platforms'] {
        const platforms: MCPServer['platforms'] = [];
        if (line.includes('☁️')) platforms.push('cloud');
        if (line.includes('🏠')) platforms.push('local');
        if (line.includes('📟')) platforms.push('embedded');
        return platforms.length > 0 ? platforms : ['local'];
    }

    /**
     * Extract operating systems from emojis
     */
    private extractOS(line: string): MCPServer['os'] {
        const os: MCPServer['os'] = [];
        if (line.includes('🍎')) os.push('mac');
        if (line.includes('🪟')) os.push('windows');
        if (line.includes('🐧')) os.push('linux');
        return os.length > 0 ? os : ['mac', 'windows', 'linux'];
    }

    /**
     * Extract tags from description
     */
    private extractTags(description: string): string[] {
        const tags: string[] = [];
        const words = description.toLowerCase().split(/\s+/);

        // Common keywords to extract as tags
        const keywords = [
            'database', 'api', 'cloud', 'browser', 'automation', 'testing',
            'deployment', 'monitoring', 'security', 'ai', 'ml', 'data',
            'analytics', 'search', 'storage', 'messaging', 'notification'
        ];

        for (const word of words) {
            for (const keyword of keywords) {
                if (word.includes(keyword) && !tags.includes(keyword)) {
                    tags.push(keyword);
                }
            }
        }

        return tags;
    }

    /**
     * Extract npm package name if mentioned
     */
    private extractNpmPackage(line: string, description: string): string | undefined {
        // Look for npm package mentions
        const npmMatch = line.match(/@[\w-]+\/[\w-]+/);
        if (npmMatch) return npmMatch[0];

        const descMatch = description.match(/@[\w-]+\/[\w-]+/);
        if (descMatch) return descMatch[0];

        return undefined;
    }

    /**
     * Build the final catalog
     */
    private buildCatalog(): MCPCatalog {
        // Count categories
        const categories: Record<string, number> = {};
        const languages: Record<string, number> = {};

        for (const server of this.servers) {
            categories[server.category] = (categories[server.category] || 0) + 1;
            languages[server.language] = (languages[server.language] || 0) + 1;
        }

        return {
            version: '1.0.0',
            lastUpdated: new Date().toISOString(),
            totalServers: this.servers.length,
            servers: this.servers,
            categories,
            languages
        };
    }
}

/**
 * Main execution
 */
async function main() {
    console.log('🔍 Parsing MCP Servers catalog...\n');

    const readmePath = join(process.cwd(), '.data', 'mcp_servers', 'README.md');
    const outputPath = join(process.cwd(), 'data', 'mcp-catalog.json');

    try {
        // Parse README
        const parser = new MCPCatalogParser(readmePath);
        const catalog = parser.parse();

        // Write catalog
        writeFileSync(outputPath, JSON.stringify(catalog, null, 2));

        // Print summary
        console.log('✅ Catalog generated successfully!\n');
        console.log(`📊 Statistics:`);
        console.log(`   Total Servers: ${catalog.totalServers}`);
        console.log(`   Categories: ${Object.keys(catalog.categories).length}`);
        console.log(`   Languages: ${Object.keys(catalog.languages).length}`);
        console.log(`\n📁 Output: ${outputPath}`);

        // Print top categories
        console.log(`\n🏆 Top Categories:`);
        const topCategories = Object.entries(catalog.categories)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10);

        for (const [category, count] of topCategories) {
            console.log(`   ${category}: ${count} servers`);
        }

        // Print language distribution
        console.log(`\n💻 Language Distribution:`);
        for (const [language, count] of Object.entries(catalog.languages).sort(([, a], [, b]) => b - a)) {
            console.log(`   ${language}: ${count} servers`);
        }

    } catch (error) {
        console.error('❌ Error parsing catalog:', error);
        process.exit(1);
    }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { MCPCatalogParser };
export type { MCPServer, MCPCatalog };
