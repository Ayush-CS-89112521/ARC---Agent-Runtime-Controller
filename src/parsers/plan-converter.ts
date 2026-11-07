import { ArchitectPlan, ArchitectPlanStep } from '../types/architect';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Fuzzy Matcher for tool hallucination recovery
 * Uses simple Levenshtein distance + category weighting
 */
class FuzzyMatcher {
  private catalog: Map<string, MCPToolSchema>;

  constructor(toolCatalog: MCPToolSchema[]) {
    this.catalog = new Map(toolCatalog.map(t => [t.id, t]));
  }

  /**
   * Find similar tools using fuzzy matching
   * Returns matches scored by: category (40%) + string similarity (60%)
   */
  findMatches(
    requestedToolId: string,
    requestedCategory?: string,
  ): FuzzyMatch[] {
    const matches: FuzzyMatch[] = [];

    for (const [id, tool] of this.catalog) {
      if (id === requestedToolId) continue; // Exact match handled elsewhere

      // String similarity (Levenshtein distance)
      const stringSimilarity = this.levenshteinSimilarity(
        requestedToolId,
        id,
      );

      // Category bonus if provided
      let categoryBonus = 0;
      if (requestedCategory && tool.category === requestedCategory) {
        categoryBonus = 0.3; // +30% boost for category match
      }

      // Weighted score: 60% string + 40% category
      const score = Math.min(
        1.0,
        stringSimilarity * 0.6 + categoryBonus * 0.4,
      );

      if (score > 0.6) {
        // Only return matches >60% similar
        matches.push({
          tool_id: id,
          tool_name: tool.name,
          similarity_score: parseFloat(score.toFixed(2)),
          category: tool.category,
          auth_type: tool.authType,
          reason: this.explainMatch(requestedToolId, id, score),
        });
      }
    }

    // Sort by score descending
    return matches.sort((a, b) => b.similarity_score - a.similarity_score);
  }

  /**
   * Levenshtein distance for string similarity
   * Returns value 0-1 (1 = identical)
   */
  private levenshteinSimilarity(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;

    const distance = this.levenshteinDistance(a, b);
    return 1.0 - distance / maxLen;
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = Array(b.length + 1)
      .fill(null)
      .map(() => Array(a.length + 1).fill(0));

    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= b.length; j++) {
      for (let i = 1; i <= a.length; i++) {
        const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + indicator,
        );
      }
    }

    return matrix[b.length][a.length];
  }

  private explainMatch(_requested: string, _matched: string, score: number) {
    if (score > 0.85) {
      return `High confidence match (${(score * 100).toFixed(0)}% similar)`;
    } else if (score > 0.7) {
      return `Medium confidence match (${(score * 100).toFixed(0)}% similar)`;
    } else {
      return `Low confidence match (${(score * 100).toFixed(0)}% similar)`;
    }
  }
}

/**
 * Plan Converter: Bridge ArchitectPlan (JSON) → Workflow (YAML/Object)
 * - Validates all tools exist in catalog
 * - Detects hallucinated tools and applies fuzzy matching
 * - Auto-injects Layer 1 safety patterns
 * - Generates explicit execution prompts
 * - Resolves dependencies into execution order
 */
export class PlanConverter {
  private fuzzyMatcher: FuzzyMatcher;
  private toolCatalog: Map<string, MCPToolSchema>;
  private warnings: string[] = [];
  private hallucinations: HallucinationAlert[] = [];

  constructor(toolCatalog: MCPToolSchema[]) {
    this.fuzzyMatcher = new FuzzyMatcher(toolCatalog);
    this.toolCatalog = new Map(toolCatalog.map(t => [t.id, t]));
  }

  /**
   * Main entry point: Convert ArchitectPlan to Workflow
   */
  async convert(plan: ArchitectPlan): Promise<ConversionResult> {
    this.warnings = [];
    this.hallucinations = [];

    // Validate plan structure
    if (!plan.steps || plan.steps.length === 0) {
      throw new Error('Plan must contain at least one step');
    }

    // Convert steps
    const workflowSteps: WorkflowStep[] = [];
    const toolMap = new Map<string, MCPToolSchema>();
    const stepIndices = new Map(plan.steps.map((step, index) => [step.step_id, index]));
    if (stepIndices.size !== plan.steps.length) throw new Error('Duplicate Architect step IDs');

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];

      // Validate and lookup tool
      const toolInfo = this.lookupTool(step.tool_needed, step.category);
      if (!toolInfo) {
        throw new Error(
          `Step ${i + 1} references tool "${step.tool_needed}" which could not be resolved`,
        );
      }

      toolMap.set(step.tool_needed, toolInfo.tool);

      // Convert step to WorkflowStep
      const workflowStep = this.convertStep(
        { ...step, dependencies: (step.dependencies || []).map(dependency => {
          const index = stepIndices.get(dependency);
          if (index === undefined) throw new Error(`Unknown Architect dependency: ${dependency}`);
          return index;
        }) },
        i,
        toolInfo.tool,
        toolInfo.action,
      );
      workflowSteps.push(workflowStep);
    }

    // Build execution graph (resolve dependencies)
    this.validateDependencies(workflowSteps);

    // Create Workflow object
    const workflow: Workflow = {
      name: plan.request_summary || 'Automated Workflow',
      ...(plan.reasoning !== undefined ? { description: plan.reasoning } : {}),
      steps: workflowSteps,
      metadata: {
        architect_plan_id: plan.plan_id || 'unknown',
        confidence_score: plan.confidence_score || 0.8,
        conversion_timestamp: new Date().toISOString(),
        tool_count: workflowSteps.length,
        hallucination_count: this.hallucinations.length,
      },
    };

    // Validate against Workflow schema
    const validation = this.validateWorkflow(workflow);
    if (!validation.valid) {
      throw new Error(
        `Workflow validation failed: ${validation.errors?.join(', ')}`,
      );
    }

    return {
      success: true,
      workflow,
      hallucinations: this.hallucinations,
      warnings: this.warnings,
      metadata: {
        original_plan_id: plan.plan_id || 'unknown',
        conversion_timestamp: new Date().toISOString(),
        converter_version: '1.0.0',
      },
    };
  }

  /**
   * Lookup tool with hallucination detection and recovery
   * Returns: { tool, action: 'exact' | 'fuzzy' | 'fallback' }
   */
  private lookupTool(
    toolId: string,
    category?: string,
  ): { tool: MCPToolSchema; action: 'exact' | 'fuzzy' | 'fallback' } | null {
    // Try exact match first
    const exactMatch = this.toolCatalog.get(toolId);
    if (exactMatch) {
      return { tool: exactMatch, action: 'exact' };
    }

    // Tool not found - attempt fuzzy match
    const fuzzyMatches = this.fuzzyMatcher.findMatches(toolId, category);

    if (fuzzyMatches.length > 0) {
      const bestMatch = fuzzyMatches[0];

      if (bestMatch.similarity_score > 0.85) {
        // High confidence - auto-accept with warning
        const tool = this.toolCatalog.get(bestMatch.tool_id);
        if (tool) {
          this.hallucinations.push({
            step_tool_requested: toolId,
            action: 'fuzzy_match',
            tool_id_suggested: bestMatch.tool_id,
            tool_name_suggested: bestMatch.tool_name,
            confidence: bestMatch.similarity_score,
            message: `Architect requested non-existent tool "${toolId}". Auto-matched to similar tool "${bestMatch.tool_name}" with ${(bestMatch.similarity_score * 100).toFixed(0)}% confidence.`,
          });
          return { tool, action: 'fuzzy' };
        }
      } else if (bestMatch.similarity_score > 0.6) {
        // Medium confidence - accept with strong warning, requires checkpoint approval
        const tool = this.toolCatalog.get(bestMatch.tool_id);
        if (tool) {
          this.hallucinations.push({
            step_tool_requested: toolId,
            action: 'fuzzy_match',
            tool_id_suggested: bestMatch.tool_id,
            tool_name_suggested: bestMatch.tool_name,
            confidence: bestMatch.similarity_score,
            message: `Architect requested non-existent tool "${toolId}". Medium-confidence match to "${bestMatch.tool_name}" (${(bestMatch.similarity_score * 100).toFixed(0)}%). Review in checkpoint before execution.`,
          });
          return { tool, action: 'fuzzy' };
        }
      }
    }

    // No acceptable fuzzy match - fallback to generic shell
    const fallbackTool = this.toolCatalog.get('generic-shell');
    if (fallbackTool) {
      this.hallucinations.push({
        step_tool_requested: toolId,
        action: 'fallback',
        tool_id_suggested: 'generic-shell',
        tool_name_suggested: 'Generic Shell Executor',
        confidence: 0.5,
        message: `Architect requested non-existent tool "${toolId}" with no suitable match. Falling back to generic shell. Review execution carefully.`,
      });
      return { tool: fallbackTool, action: 'fallback' };
    }

    // No fallback available
    return null;
  }

  /**
   * Convert single ArchitectPlanStep to WorkflowStep
   */
  private convertStep(
    step: ArchitectPlanStep,
    index: number,
    tool: MCPToolSchema,
    action: 'exact' | 'fuzzy' | 'fallback',
  ): WorkflowStep {
    // Generate explicit execution prompt
    const prompt = this.generatePrompt(step, tool, action);

    // Build conditional logic from dependencies
    const when =
      step.dependencies && step.dependencies.length > 0
        ? step.dependencies.map(dep => `step_${dep}_complete == true`).join(' && ')
        : undefined;

    return {
      id: `step_${index}`,
      name: step.step_name || `Step ${index + 1}`,
      description: step.reasoning,
      tools: [
        {
          id: tool.id,
          name: tool.name,
          auth_type: tool.authType,
          category: tool.category,
        },
      ],
      prompt,
      ...(step.input !== undefined ? { input: step.input } : {}),
      ...(step.expected_output !== undefined ? { expected_output: step.expected_output } : {}),
      ...(when !== undefined ? { when } : {}),
      safety: {
        pattern_scan: true,
        require_approval:
          tool.authType !== 'none' || tool.scope !== 'read-only' || action === 'fallback'
            ? true
            : false,
        timeout: this.calculateTimeout(tool),
      },
      error_handling: {
        on_failure: 'stop_workflow', // Can be modified per checkpoint
        fallback_enabled: action === 'fallback',
      },
      metadata: {
        tool_action: action,
        confidence_score: step.confidence || 0.8,
        index,
      },
    };
  }

  /**
   * Generate explicit execution prompt for the step
   */
  private generatePrompt(
    step: ArchitectPlanStep,
    tool: MCPToolSchema,
    action: 'exact' | 'fuzzy' | 'fallback',
  ): string {
    let prompt = `Execute the following architectural requirement:\n\n`;
    prompt += `**Objective**: ${step.reasoning}\n\n`;

    if (step.expected_output) {
      prompt += `**Expected Output**: ${step.expected_output}\n\n`;
    }

    prompt += `**Tool**: ${tool.name} (${tool.id})\n`;
    prompt += `**Category**: ${tool.category}\n\n`;

    if (step.dependencies && step.dependencies.length > 0) {
      prompt += `**Dependencies**: This step depends on steps [${step.dependencies.join(', ')}] completing successfully.\n\n`;
    }

    if (action === 'fuzzy') {
      prompt += `⚠️ **Note**: The architect's original tool reference was adjusted to this similar tool. Verify the substitution is appropriate.\n\n`;
    }

    if (action === 'fallback') {
      prompt += `⚠️ **IMPORTANT**: The original tool reference was not found. Using generic shell executor as fallback. Ensure your command accomplishes the objective.\n\n`;
    }

    prompt += `Please use the ${tool.name} tool to accomplish this objective.`;

    return prompt;
  }

  /**
   * Calculate reasonable timeout based on tool scope
   */
  private calculateTimeout(tool: MCPToolSchema): number {
    const scopeTimeouts: Record<string, number> = {
      'read-only': 30000, // 30 seconds
      'modify': 60000, // 60 seconds
      'create': 120000, // 2 minutes
      'delete': 180000, // 3 minutes
      'full-control': 300000, // 5 minutes
    };
    return scopeTimeouts[tool.scope] || 60000;
  }

  /**
   * Validate no circular dependencies exist
   */
  private validateDependencies(steps: WorkflowStep[]): void {
    const graph = new Map<string, Set<string>>();

    // Build adjacency list
    for (const step of steps) {
      graph.set(step.id, new Set());
      if (step.when) {
        // Parse "step_X_complete == true" conditions
        const matches = step.when.match(/step_\d+/g);
        if (matches) {
          const deps = matches.map(m => m);
          for (const dep of deps) {
            graph.get(step.id)?.add(dep);
          }
        }
      }
    }

    // Detect cycles via DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (node: string): boolean => {
      visited.add(node);
      recursionStack.add(node);

      const neighbors = graph.get(node) || new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          if (hasCycle(neighbor)) return true;
        } else if (recursionStack.has(neighbor)) {
          return true;
        }
      }

      recursionStack.delete(node);
      return false;
    };

    for (const [node] of graph) {
      if (!visited.has(node)) {
        if (hasCycle(node)) {
          throw new Error(
            'Circular dependency detected in workflow steps. Cannot execute.',
          );
        }
      }
    }
  }

  /**
   * Validate Workflow object structure
   */
  private validateWorkflow(workflow: Workflow): ValidationResult {
    const errors: string[] = [];

    if (!workflow.name) errors.push('Workflow must have a name');
    if (!workflow.steps || workflow.steps.length === 0)
      errors.push('Workflow must have at least one step');

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      if (!step.name) errors.push(`Step ${i} missing name`);
      if (!step.tools || step.tools.length === 0)
        errors.push(`Step ${i} must have tools`);
      if (!step.prompt) errors.push(`Step ${i} missing prompt`);
      if (step.safety && typeof step.safety.pattern_scan !== 'boolean')
        errors.push(`Step ${i} safety.pattern_scan must be boolean`);
    }

    return {
      valid: errors.length === 0,
      ...(errors.length > 0 ? { errors } : {}),
    };
  }
}

/**
 * Load MCP Tool Catalog from JSON
 */
export function loadToolCatalog(catalogPath?: string): MCPToolSchema[] {
  const path = catalogPath || resolve(__dirname, '../../data/mcp-catalog.json');
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as MCPToolSchema[];
  } catch (error) {
    console.error(`Failed to load tool catalog from ${path}:`, error);
    return [];
  }
}

/**
 * Convenience function: Convert plan with auto-loaded catalog
 */
export async function convertPlanToWorkflow(
  plan: ArchitectPlan,
  catalogPath?: string,
): Promise<ConversionResult> {
  const catalog = loadToolCatalog(catalogPath);
  const converter = new PlanConverter((catalog as any).tools || catalog);
  return converter.convert(plan);
}

// Type definitions (matching existing ARC types)

export interface MCPToolSchema {
  id: string;
  name: string;
  description: string;
  category: string;
  authType: 'none' | 'api-key' | 'oauth2' | 'bearer-token';
  scope: 'read-only' | 'modify' | 'create' | 'delete' | 'full-control';
  auth?: {
    type: string;
    required: boolean;
  };
}

export interface FuzzyMatch {
  tool_id: string;
  tool_name: string;
  similarity_score: number;
  category: string;
  auth_type: string;
  reason: string;
}

export interface HallucinationAlert {
  step_tool_requested: string;
  action: 'fuzzy_match' | 'fallback';
  tool_id_suggested: string;
  tool_name_suggested: string;
  confidence: number;
  message: string;
}

export interface WorkflowStep {
  input?: unknown;
  id: string;
  name: string;
  description?: string;
  tools: Array<{
    id: string;
    name: string;
    auth_type: string;
    category: string;
  }>;
  prompt: string;
  expected_output?: string;
  when?: string; // Conditional execution: "step_1_complete == true && step_2_complete == true"
  safety: {
    pattern_scan: boolean;
    require_approval: boolean;
    timeout: number; // milliseconds
  };
  error_handling: {
    on_failure: 'stop_workflow' | 'skip_step' | 'retry';
    fallback_enabled: boolean;
  };
  metadata: {
    tool_action: 'exact' | 'fuzzy' | 'fallback';
    confidence_score: number;
    index: number;
    [key: string]: any;
  };
}

export interface Workflow {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  config?: any;
  metadata: {
    architect_plan_id: string;
    confidence_score: number;
    conversion_timestamp: string;
    tool_count: number;
    hallucination_count: number;
    [key: string]: any;
  };
}

export interface ConversionResult {
  success: boolean;
  workflow: Workflow;
  hallucinations: HallucinationAlert[];
  warnings: string[];
  metadata: {
    original_plan_id: string;
    conversion_timestamp: string;
    converter_version: string;
  };
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}
