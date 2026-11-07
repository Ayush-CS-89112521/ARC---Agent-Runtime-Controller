/**
 * Phase 6: Architect Service
 * Combines Tool Pruner + Architect Agent
 */

import { ToolPruner } from '../optimization/tool-pruner.js';
import { ArchitectAgent } from '../agents/architect.js';
import type {
  ArchitectServiceConfig,
  ArchitectResponse,
} from '../types/architect.js';

/**
 * High-level service combining Pruner + Agent
 */
export class ArchitectService {
  private pruner: ToolPruner;
  private agent: ArchitectAgent;
  private config: ArchitectServiceConfig;

  constructor(config?: Partial<ArchitectServiceConfig>, catalog?: import('../parsers/plan-converter.js').MCPToolSchema[], agent?: ArchitectAgent) {
    this.config = {
      model_tier: 'haiku',
      max_input_tokens: 2000,
      max_output_tokens: 1000,
      temperature: 0.3,
      system_prompt: '',
      pruner: {
        max_relevant_tools: 20,
        min_relevance_score: 1,
        selection_strategy: 'hybrid',
      },
      enable_token_counting: true,
      enable_validation: true,
      ...config,
    };

    this.pruner = new ToolPruner(this.config.pruner, catalog?.map(tool => ({ id: tool.id, name: tool.name, description: tool.description, category: tool.category })));
    this.agent = agent ?? new ArchitectAgent({
      model_tier: this.config.model_tier,
      max_input_tokens: this.config.max_input_tokens,
      max_output_tokens: this.config.max_output_tokens,
      temperature: this.config.temperature,
    });
  }

  /**
   * Main entry point: Create plan from user request
   * Handles pruning + planning + validation
   */
  async createPlanFromRequest(request: string, signal?: AbortSignal, retrievedContext?: string): Promise<ArchitectResponse> {
    try {
      // Step 1: Prune catalog
      const toolIndex = this.pruner.pruneCatalog();
      console.log(`📦 Pruned catalog: ${toolIndex.pruned_count} tools, ~${toolIndex.token_estimate} tokens`);

      // Step 2: Select relevant tools based on request
      const selection = this.pruner.selectRelevantTools(request);
      console.log(`🔍 Selected ${selection.selected_tools.length} relevant tools in ${selection.execution_time_ms}ms`);

      // Create a focused tool index
      const focusedIndex = {
        ...toolIndex,
        pruned_tools: selection.selected_tools,
        pruned_count: selection.selected_tools.length,
      };

      // Step 3: Generate plan
      const plan = await this.agent.plan(request, focusedIndex, signal, retrievedContext);

      // Step 4: Validate if enabled
      if (this.config.enable_validation && !('error_code' in plan)) {
        const validation = this.agent.validatePlan(plan, focusedIndex);
        if (!validation.is_valid) {
          console.warn('⚠️ Plan validation warnings:', validation.warnings);
          if (validation.errors.length > 0) {
            return { error_code: 'INVALID_PLAN', error_message: validation.errors.join('; ') };
          }
        }
      }

      return plan;
    } catch (error) {
      return {
        error_code: 'SERVICE_ERROR',
        error_message: `Architect service error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Get the pruned catalog (for inspection)
   */
  getPrunedCatalog() {
    return this.pruner.pruneCatalog();
  }

  /**
   * Validate a specific tool exists
   */
  validateTool(toolId: string): boolean {
    return this.pruner.validateToolId(toolId);
  }

  /**
   * Get current configuration
   */
  getConfig(): ArchitectServiceConfig {
    return { ...this.config };
  }
}

/**
 * Create a default service instance
 */
export function createArchitectService(config?: Partial<ArchitectServiceConfig>): ArchitectService {
  return new ArchitectService(config);
}
