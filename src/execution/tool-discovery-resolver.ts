/**
 * Tool Discovery Resolver
 * 
 * Integrates MCP registry with VariableResolver to support tool discovery patterns:
 * - ${tools.figma} - Look up tool in registry
 * - ${tool.figma.endpoint} - Get service endpoint
 * - ${tool.figma.requiredEnv} - Get required environment variables
 * - ${apis.github} - API discovery shorthand
 * 
 * Part of Layer -1: Runtime Tool Discovery Infrastructure
 */

import * as fs from "fs";
import * as path from "path";
import type { ExecutionContext } from "../types/index.js";
import type { ToolDescriptor, MCPCatalog, ToolAvailabilityCheck, ToolVariableResolutionResult } from "../types/tool-discovery.js";

/**
 * Tool Discovery Service - Manages catalog loading and caching
 */
export class ToolDiscoveryService {
  private catalog: MCPCatalog | null = null;
  private catalogLoadedAt: Date | null = null;
  private toolIndex: Map<string, ToolDescriptor> = new Map();
  private availabilityCache: Map<string, ToolAvailabilityCheck> = new Map();
  private cacheTTL: number = 5 * 60 * 1000; // 5 minutes
  private catalogPath: string;

  constructor(catalogPath?: string) {
    // Default to data/mcp-catalog.json relative to project root
    this.catalogPath = catalogPath || path.resolve(process.cwd(), 'data', 'mcp-catalog.json');
  }

  /**
   * Load or reload the MCP catalog from disk
   * Builds in-memory index for O(1) tool lookups
   */
  async loadCatalog(): Promise<MCPCatalog> {
    if (this.catalog && this.catalogLoadedAt) {
      const age = Date.now() - this.catalogLoadedAt.getTime();
      if (age < this.cacheTTL) {
        return this.catalog; // Use cached catalog
      }
    }

    if (!fs.existsSync(this.catalogPath)) {
      throw new Error(
        `MCP Catalog not found at ${this.catalogPath}. ` +
        `Run 'bun scripts/compile-mcp-registry.ts' to generate it.`
      );
    }

    const content = fs.readFileSync(this.catalogPath, 'utf-8');
    this.catalog = JSON.parse(content) as MCPCatalog;
    this.catalogLoadedAt = new Date();

    // Build index for O(1) lookups
    this.toolIndex.clear();
    for (const tool of this.catalog.tools) {
      this.toolIndex.set(tool.id.toLowerCase(), tool);
      // Also index by name for fuzzy matching
      this.toolIndex.set(tool.name.toLowerCase(), tool);
    }

    return this.catalog;
  }

  /**
   * Find a tool in the registry by ID, name, or category
   * Supports fuzzy matching for user-friendly discovery
   */
  async findTool(query: string): Promise<ToolDescriptor | null> {
    if (!this.catalog) {
      await this.loadCatalog();
    }

    const queryLower = query.toLowerCase();

    // Exact match by ID or name
    if (this.toolIndex.has(queryLower)) {
      return this.toolIndex.get(queryLower) || null;
    }

    // Partial match in name
    for (const tool of Array.from(this.toolIndex.values())) {
      if (tool.name.toLowerCase().includes(queryLower)) {
        return tool;
      }
    }

    // Partial match in category
    for (const tool of Array.from(this.toolIndex.values())) {
      if (tool.category.toLowerCase().includes(queryLower)) {
        return tool;
      }
    }

    return null;
  }

  /**
   * Search MCP servers with advanced filtering and fuzzy matching
   */
  async searchMCPServers(
    query: string,
    options?: {
      category?: string;
      language?: string;
      platform?: string;
      limit?: number;
    }
  ): Promise<Array<ToolDescriptor & { score: number }>> {
    if (!this.catalog) {
      await this.loadCatalog();
    }

    const queryLower = query.toLowerCase();
    const results: Array<ToolDescriptor & { score: number }> = [];

    for (const tool of this.catalog!.tools) {
      // Apply filters
      if (options?.category && tool.category !== options.category) continue;
      if (options?.language && !tool.languages.includes(options.language)) continue;
      if (options?.platform && tool.scope !== options.platform) continue;

      // Calculate similarity score
      const score = this.calculateSimilarity(queryLower, tool);

      if (score > 0) {
        results.push({ ...tool, score });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Apply limit
    return options?.limit ? results.slice(0, options.limit) : results;
  }

  /**
   * Calculate similarity score between query and tool
   * Uses Jaccard similarity for fuzzy matching
   */
  private calculateSimilarity(query: string, tool: ToolDescriptor): number {
    const queryTokens = new Set(query.split(/\s+/));
    const nameTokens = new Set(tool.name.toLowerCase().split(/[\s-_/]+/));
    const descTokens = new Set((tool.description || '').toLowerCase().split(/\s+/));
    const categoryTokens = new Set(tool.category.toLowerCase().split(/\s+/));

    // Exact match bonus
    if (tool.name.toLowerCase() === query) return 1.0;
    if (tool.id.toLowerCase() === query) return 1.0;

    // Calculate Jaccard similarity
    const allTokens = new Set([...nameTokens, ...descTokens, ...categoryTokens]);
    const intersection = new Set([...queryTokens].filter(t => allTokens.has(t)));
    const union = new Set([...queryTokens, ...allTokens]);

    const jaccardScore = intersection.size / union.size;

    // Boost score if query appears in name or category
    let boost = 0;
    if (tool.name.toLowerCase().includes(query)) boost += 0.3;
    if (tool.category.toLowerCase().includes(query)) boost += 0.2;
    if (tool.description?.toLowerCase().includes(query)) boost += 0.1;

    return Math.min(jaccardScore + boost, 1.0);
  }

  /**
   * Validate tool availability by checking environment variables
   */
  async checkAvailability(tool: ToolDescriptor): Promise<ToolAvailabilityCheck> {
    const cacheKey = tool.id;
    const cached = this.availabilityCache.get(cacheKey);

    if (cached) {
      const age = Date.now() - new Date(cached.timestamp).getTime();
      if (age < this.cacheTTL) {
        return cached; // Use cached result
      }
    }

    const missingEnvVars: string[] = [];

    // Check required environment variables
    if (tool.commonEnvVars && tool.commonEnvVars.length > 0) {
      for (const envVar of tool.commonEnvVars) {
        if (!process.env[envVar]) {
          missingEnvVars.push(envVar);
        }
      }
    }

    // Suggest MCP command if it's an official tool
    let mcpCommand: string | undefined;
    if (tool.isOfficial) {
      const owner = tool.id.split('/')[0];
      const repo = tool.id.split('/')[1];
      // Standard MCP convention: @owner/mcp-server-name
      mcpCommand = `npx @${owner}/mcp-server-${repo}`;
    }

    const result: ToolAvailabilityCheck = {
      toolId: tool.id,
      found: true,
      metadata: tool,
      missingEnvVars,
      mcpCommand,
      timestamp: new Date().toISOString(),
      cacheHit: false,
    };

    // Cache result
    this.availabilityCache.set(cacheKey, result);

    return result;
  }

  /**
   * Get tools by category
   */
  async getToolsByCategory(category: string): Promise<ToolDescriptor[]> {
    if (!this.catalog) {
      await this.loadCatalog();
    }

    return this.catalog!.tools.filter(t => t.category === category);
  }

  /**
   * Get catalog metadata
   */
  async getCatalogInfo(): Promise<{ version: string; toolCount: number; categories: number; updatedAt: string }> {
    if (!this.catalog) {
      await this.loadCatalog();
    }

    return {
      version: this.catalog!.version,
      toolCount: this.catalog!.toolCount,
      categories: this.catalog!.categories.length,
      updatedAt: this.catalog!.generatedAt,
    };
  }
}

/**
 * Resolve tool discovery variable patterns
 * Supports: ${tools.name}, ${tool.name.endpoint}, ${apis.name}
 */
export async function resolveToolVariable(
  pattern: string,
  _context: ExecutionContext,
  service: ToolDiscoveryService
): Promise<ToolVariableResolutionResult> {
  // Extract pattern components: ${tools.figma} or ${tool.figma.endpoint}
  const match = pattern.match(/\$\{(tools|tool|apis)\.([a-zA-Z0-9_-]+)(?:\.([a-zA-Z0-9_-]+))?\}/);

  if (!match) {
    return {
      resolved: false,
      error: `Invalid tool discovery pattern: ${pattern}. Expected: \${tools.NAME}, \${tool.NAME.PROPERTY}, or \${apis.NAME}`,
    };
  }

  const [_, patternType, toolName, property] = match;

  try {
    // Find tool in catalog
    const tool = await service.findTool(toolName);
    if (!tool) {
      return {
        resolved: false,
        error: `Tool '${toolName}' not found in MCP registry. Use 'arc --list-tools' to see available tools.`,
      };
    }

    // Check availability
    const availability = await service.checkAvailability(tool);

    // Handle property access: ${tool.figma.endpoint}, ${tool.figma.requiredEnv}
    if (property) {
      switch (property.toLowerCase()) {
        case 'endpoint':
        case 'url':
          return {
            resolved: true,
            toolId: tool.id,
            metadata: tool,
            endpoint: tool.repositoryUrl,
          };

        case 'requiredenv':
        case 'env':
        case 'required':
          return {
            resolved: true,
            toolId: tool.id,
            metadata: tool,
            requiredEnvVars: tool.commonEnvVars || [],
          };

        case 'command':
        case 'mcp':
          return {
            resolved: true,
            toolId: tool.id,
            metadata: tool,
            mcpCommand: availability.mcpCommand,
          };

        case 'available':
        case 'status':
          return {
            resolved: true,
            toolId: tool.id,
            metadata: tool,
            endpoint: availability.missingEnvVars.length === 0 ? 'available' : 'missing_env',
          };

        default:
          return {
            resolved: false,
            error: `Unknown property '${property}' for tool. Supported: endpoint, requiredEnv, command, available`,
          };
      }
    }

    // Return tool metadata as JSON string for ${tools.name} pattern
    if (patternType === 'tools' || patternType === 'apis') {
      return {
        resolved: true,
        toolId: tool.id,
        metadata: tool,
        endpoint: JSON.stringify({
          id: tool.id,
          name: tool.name,
          category: tool.category,
          scope: tool.scope,
          languages: tool.languages,
          resourceProfile: tool.estimatedResourceProfile,
          requiredEnvVars: tool.commonEnvVars || [],
          available: availability.missingEnvVars.length === 0,
          missingEnvVars: availability.missingEnvVars,
        }),
      };
    }

    return {
      resolved: true,
      toolId: tool.id,
      metadata: tool,
      endpoint: tool.repositoryUrl,
    };

  } catch (error) {
    return {
      resolved: false,
      error: `Tool discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Enrich execution context with tool metadata for downstream layers
 */
export async function enrichContextWithTools(
  context: ExecutionContext,
  service: ToolDiscoveryService
): Promise<void> {
  // Initialize toolMetadata if not present
  if (!context.toolMetadata) {
    context.toolMetadata = new Map();
  }

  // Scan prompt for tool patterns
  const toolPattern = /\$\{(?:tools|tool|apis)\.([a-zA-Z0-9_-]+)/g;
  const matches = context.prompt?.match(toolPattern) || [];

  // Resolve and cache metadata for each tool mentioned
  for (const match of matches) {
    const toolName = match.match(/\.([a-zA-Z0-9_-]+)/)?.[1];
    if (toolName) {
      const tool = await service.findTool(toolName);
      if (tool) {
        context.toolMetadata.set(tool.id, tool);
      }
    }
  }
}
