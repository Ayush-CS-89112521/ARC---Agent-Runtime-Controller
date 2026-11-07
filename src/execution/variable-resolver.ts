/**
 * Variable Resolver - Resolves variable references in prompts
 * Handles pattern scanning, parsing, validation, and substitution
 * Enhanced with API registry integration for agentic tool selection
 */

import { ExecutionContext, VariableReference } from '../types/index.js';

/**
 * Error classes for specific resolution failure modes
 */
export class VariableResolutionError extends Error {
  constructor(message: string, public readonly reference?: string) {
    super(message);
    this.name = 'VariableResolutionError';
  }
}

export class ForwardReferenceError extends VariableResolutionError {
  constructor(message: string, reference?: string) {
    super(message, reference);
    this.name = 'ForwardReferenceError';
  }
}

export class VariableNotFoundError extends VariableResolutionError {
  constructor(message: string, reference?: string) {
    super(message, reference);
    this.name = 'VariableNotFoundError';
  }
}

export class MissingPropertyError extends VariableResolutionError {
  constructor(message: string, reference?: string) {
    super(message, reference);
    this.name = 'MissingPropertyError';
  }
}

export class StepExecutionError extends VariableResolutionError {
  constructor(message: string, reference?: string) {
    super(message, reference);
    this.name = 'StepExecutionError';
  }
}

/**
 * Scan a prompt string for variable reference patterns
 * Matches ${...} syntax
 *
 * @param prompt - The prompt string to scan
 * @returns Array of matched variable reference patterns (or empty array)
 *
 * @example
 * scanPrompt('Use ${steps.step1.output}') → ['${steps.step1.output}']
 * scanPrompt('No variables here') → []
 */
export function scanPrompt(prompt: string): string[] {
  const pattern = /\$\{[^}]+\}/g;
  return prompt.match(pattern) || [];
}

/**
 * Parse a variable reference pattern into its components
 * Validates the pattern format and extracts the path
 *
 * @param pattern - The pattern string (e.g., '${steps.step1.output.field}')
 * @returns A VariableReference object with parsed path
 * @throws VariableResolutionError if pattern format is invalid
 *
 * @example
 * parseReference('${steps.step1.output}') → {
 *   reference: 'steps.step1.output',
 *   path: ['steps', 'step1', 'output']
 * }
 */
export function parseReference(pattern: string): VariableReference {
  // Extract content between ${ and }
  if (!pattern.startsWith('${') || !pattern.endsWith('}')) {
    throw new VariableResolutionError(
      `Invalid variable reference pattern: '${pattern}'. Expected format: \$\{steps.stepId.output\}`,
      pattern
    );
  }

  const content = pattern.slice(2, -1);

  // Split by dots to get path segments
  const path = content.split('.');

  // Validate that first segment is 'steps'
  if (path[0] !== 'steps') {
    throw new VariableResolutionError(
      `Variable reference must start with 'steps'. Got: '${path[0]}'`,
      content
    );
  }

  // Validate that at least stepId is specified
  if (path.length < 2) {
    throw new VariableResolutionError(
      `Variable reference must include step ID. Expected: \$\{steps.STEP_ID.OUTPUT\}`,
      content
    );
  }

  return {
    reference: content,
    path,
  };
}

/**
 * Error class for skipped step references
 */
export class SkippedStepReferenceError extends VariableResolutionError {
  constructor(message: string, reference?: string) {
    super(message, reference);
    this.name = 'SkippedStepReferenceError';
  }
}

/**
 * Retrieve a value from the context using a parsed path
 * Supports nested property access with fallback error messages
 *
 * @param context - The execution context
 * @param path - The parsed path array
 * @returns The resolved value
 * @throws ForwardReferenceError if step hasn't executed yet
 * @throws SkippedStepReferenceError if step was skipped due to failed condition
 * @throws StepExecutionError if step failed
 * @throws VariableNotFoundError if variable not in context
 * @throws MissingPropertyError if nested property access fails
 */
function resolveValueFromPath(context: ExecutionContext, path: string[]): unknown {
  const stepId = path[1];
  const varKey = path[2] || 'output'; // Default to 'output' if not specified

  // Validation 0: Check if step was intentionally skipped due to condition
  const skippedStep = context.skippedSteps?.find((s) => s.stepId === stepId);
  if (skippedStep) {
    throw new SkippedStepReferenceError(
      `Step '${stepId}' was skipped due to a failed 'when' condition. ` +
        `Cannot reference outputs from skipped steps. ` +
        `Condition: ${skippedStep.reason}. ` +
        `Consider adding a 'when' clause to this step too, or ensure the referenced step is not conditional.`,
      path.join('.')
    );
  }

  // Validation 1: Check if step has been executed
  const stepResult = context.results.find((r) => r.stepId === stepId);
  if (!stepResult) {
    const executedSteps = context.results.map((r) => r.stepId).join(', ');
    throw new ForwardReferenceError(
      `Step '${stepId}' referenced in prompt has not executed yet. ` +
        `Steps must reference outputs from previously completed steps. ` +
        `Execution order so far: [${executedSteps || 'none'}]`,
      path.join('.')
    );
  }

  // Validation 2: Check if step succeeded
  if (!stepResult.success) {
    throw new StepExecutionError(
      `Step '${stepId}' failed with error: ${stepResult.error || 'unknown error'}. ` +
        `Cannot resolve variables from failed steps.`,
      path.join('.')
    );
  }

  // Validation 3: Check if variable exists in context
  const usesStepOutput = varKey === 'output' && stepResult.parsedOutput !== undefined;
  if (!usesStepOutput && !context.variables.has(varKey)) {
    const availableVars = Array.from(context.variables.keys()).join(', ');
    throw new VariableNotFoundError(
      `Variable '${varKey}' from step '${stepId}' not found in context. ` +
        `Available variables: ${availableVars || 'none'}`,
      path.join('.')
    );
  }

  // Get the initial value from variables map
  let value = usesStepOutput
    ? (path.length > 3 ? stepResult.parsedOutput : stepResult.output)
    : context.variables.get(varKey);
  if (!usesStepOutput && path.length > 3 && typeof value === 'string') {
    try { value = JSON.parse(value); } catch { /* Plain text has no nested fields. */ }
  }

  // Traverse nested properties if path extends beyond [steps, stepId, varKey]
  for (let i = 3; i < path.length; i++) {
    const property = path[i];

    // Check for null/undefined before property access
    if (value === null || value === undefined) {
      throw new MissingPropertyError(
        `Cannot access property '${property}' on null/undefined value. ` +
        `Full path: ${path.join('.')}. ` +
        `Value up to '${path[i - 1]}' was: ${value}`,
        path.join('.')
      );
    }

    // Support both object properties and array indices
    if (typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, property)) {
      value = (value as Record<string, unknown>)[property];
    } else {
      throw new MissingPropertyError(
        `Property '${property}' not found in object. ` +
        `Available properties: ${Object.keys(value as object).join(', ')}. ` +
        `Path: ${path.join('.')}`,
        path.join('.')
      );
    }
  }

  return value;
}

/**
 * Validate and resolve a single variable reference against the execution context
 *
 * @param reference - The parsed variable reference
 * @param context - The execution context
 * @returns The resolved value
 * @throws Various resolution errors with descriptive messages
 */
export function validateAndResolve(
  reference: VariableReference,
  context: ExecutionContext
): unknown {
  return resolveValueFromPath(context, reference.path);
}

/**
 * Resolve all variable references in a prompt and substitute their values
 * Handles type coercion (objects/arrays to JSON string representation)
 *
 * @param prompt - The prompt string containing variable references
 * @param context - The execution context
 * @returns The resolved prompt with all variables substituted
 * @throws VariableResolutionError and its subclasses on validation failure
 *
 * @example
 * context.variables.set('output', 'success')
 * resolvePrompt('Result: ${steps.step1.output}', context)
 * → 'Result: success'
 */
export function resolvePrompt(prompt: string, context: ExecutionContext): string {
  const patterns = scanPrompt(prompt);

  let resolved = prompt;

  for (const pattern of patterns) {
    try {
      const reference = parseReference(pattern);
      const value = validateAndResolve(reference, context);

      // Coerce value to string
      let stringValue: string;
      if (typeof value === 'string') {
        stringValue = value;
      } else if (value === null) {
        stringValue = 'null';
      } else if (value === undefined) {
        stringValue = 'undefined';
      } else {
        // For objects and arrays, serialize to JSON
        stringValue = JSON.stringify(value);
      }

      // Replace the pattern with the resolved value
      resolved = resolved.replace(pattern, stringValue);
    } catch (error) {
      // Re-throw resolution errors with additional context about the pattern
      if (error instanceof VariableResolutionError) {
        throw error;
      }
      throw new VariableResolutionError(
        `Failed to resolve variable reference '${pattern}': ${error instanceof Error ? error.message : String(error)}`,
        pattern
      );
    }
  }

  return resolved;
}

/**
 * Build a dependency graph from a workflow
 * Useful for pre-execution validation to catch forward references early
 *
 * @param workflowSteps - Array of workflow steps
 * @returns A map of step IDs to their dependencies (other step IDs they reference)
 *
 * @example
 * buildDependencyGraph([
 *   { id: 'step1', prompt: 'initial' },
 *   { id: 'step2', prompt: 'use ${steps.step1.output}' }
 * ]) → { step2: ['step1'] }
 */
export function buildDependencyGraph(
  workflowSteps: Array<{ id: string; prompt: string }>
): Record<string, string[]> {
  const dependencies: Record<string, string[]> = {};

  for (const step of workflowSteps) {
    const patterns = scanPrompt(step.prompt);
    const stepDependencies: Set<string> = new Set();

    for (const pattern of patterns) {
      try {
        const reference = parseReference(pattern);
        const referencedStepId = reference.path[1];
        stepDependencies.add(referencedStepId);
      } catch {
        // Skip invalid references (will be caught during execution)
      }
    }

    if (stepDependencies.size > 0) {
      dependencies[step.id] = Array.from(stepDependencies);
    }
  }

  return dependencies;
}

/**
 * Validate dependency ordering in a workflow
 * Checks for forward references and circular dependencies
 *
 * @param workflowSteps - Array of workflow steps
 * @throws ForwardReferenceError if a step references a step that comes after it
 * @throws VariableResolutionError if circular dependencies are detected
 */
export function validateDependencyOrder(
  workflowSteps: Array<{ id: string; prompt: string }>
): void {
  const dependencies = buildDependencyGraph(workflowSteps);
  const stepOrder = workflowSteps.map((s) => s.id);
  const stepIndexMap = new Map(stepOrder.map((id, index) => [id, index]));

  // Check for forward references
  for (const [stepId, deps] of Object.entries(dependencies)) {
    const stepIndex = stepIndexMap.get(stepId)!;

    for (const depId of deps) {
      const depIndex = stepIndexMap.get(depId);

      if (depIndex === undefined) {
        throw new VariableResolutionError(
          `Step '${stepId}' references non-existent step '${depId}'`
        );
      }

      if (depIndex > stepIndex) {
        throw new ForwardReferenceError(
          `Step '${stepId}' references step '${depId}' which comes after it in execution order. ` +
            `Reorder steps so dependencies run first.`,
          `steps.${depId}`
        );
      }
    }
  }

  // Simple circular dependency detection via DFS
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(stepId: string): boolean {
    visited.add(stepId);
    recursionStack.add(stepId);

    const deps = dependencies[stepId] || [];
    for (const depId of deps) {
      if (!visited.has(depId)) {
        if (hasCycle(depId)) {
          return true;
        }
      } else if (recursionStack.has(depId)) {
        return true;
      }
    }

    recursionStack.delete(stepId);
    return false;
  }

  for (const stepId of stepOrder) {
    if (!visited.has(stepId)) {
      if (hasCycle(stepId)) {
        throw new VariableResolutionError(
          `Circular dependency detected involving step '${stepId}'. ` +
            `Review step prompts and reorder to break the cycle.`
        );
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// API REGISTRY INTEGRATION (Phase 3 Enhancement)
// ─────────────────────────────────────────────────────────────────

/**
 * Type for API registry entries (imported from data/api-registry.json)
 */
export interface ApiEntry {
  id: string;
  name: string;
  url: string;
  category: string;
  description: string;
  domain: string;
  authType: 'none' | 'apiKey' | 'oauth' | 'other';
  https: boolean;
  cors: 'yes' | 'no' | 'unknown';
  protocols?: string[];
}

/**
 * Type for suggested tools from registry
 */
export interface SuggestedTool {
  id: string;
  name: string;
  url: string;
  confidence: number;                // 0-1 relevance score
  authType: 'none' | 'apiKey' | 'oauth' | 'other';
  category: string;
  description: string;
  domain: string;                   // API domain (required)
  baseUrl?: string | undefined;     // Optional API base URL
  sampleEndpoint?: string | undefined;          // Optional sample endpoint
}

/**
 * Extract keywords from a prompt for tool suggestions
 * Filters out common stop words and extracts meaningful terms
 *
 * @param prompt - The user prompt
 * @returns Array of extracted keywords
 *
 * @example
 * extractKeywords('Get stock price data for Apple')
 * → ['stock', 'price', 'data', 'apple']
 */
export function extractKeywords(prompt: string): string[] {
  const stopWords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
    'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
    'the', 'to', 'was', 'will', 'with', 'get', 'use', 'using', 'using',
  ]);

  const keywords = prompt
    .toLowerCase()
    .split(/\s+/)
    .filter(word => {
      // Remove non-alphanumeric, keep words >2 chars, exclude stop words
      const cleaned = word.replace(/[^a-z0-9]/g, '');
      return cleaned.length > 2 && !stopWords.has(cleaned);
    });

  return [...new Set(keywords)]; // Remove duplicates
}

/**
 * Calculate relevance score between keywords and an API entry
 *
 * @param api - The API entry to score
 * @param keywords - Keywords from prompt
 * @returns Score between 0 and 1
 */
function calculateRelevance(api: ApiEntry, keywords: string[]): number {
  let score = 0;
  const maxScore = keywords.length; // Max: 1 point per keyword match

  // Check tags (name, description, category)
  const apiText = `${api.name} ${api.description} ${api.category}`.toLowerCase();

  keywords.forEach(keyword => {
    // Exact match in name: +1.0
    if (api.name.toLowerCase().includes(keyword)) {
      score += 1.0;
      return;
    }

    // Match in description: +0.7
    if (api.description.toLowerCase().includes(keyword)) {
      score += 0.7;
      return;
    }

    // Match in category: +0.5
    if (api.category.toLowerCase().includes(keyword)) {
      score += 0.5;
      return;
    }

    // Word boundary match anywhere: +0.3
    if (apiText.includes(keyword)) {
      score += 0.3;
    }
  });

  // Normalize to 0-1 range
  return Math.min(score / maxScore, 1.0);
}

/**
 * Suggest relevant APIs from registry based on prompt keywords
 * Returns top matches ranked by relevance and auth type simplicity
 *
 * @param prompt - The user prompt
 * @param registry - The API registry (loaded from data/api-registry.json)
 * @param limit - Maximum suggestions to return (default: 5)
 * @returns Array of suggested tools, ranked by relevance
 *
 * @example
 * const tools = suggestToolsFromPrompt('Get stock data', registry);
 * // Returns: [
 * //   { id: 'alpha-vantage', name: 'Alpha Vantage', confidence: 0.95, ... },
 * //   { id: 'marketstack', name: 'Marketstack', confidence: 0.88, ... }
 * // ]
 */
export function suggestToolsFromPrompt(
  prompt: string,
  registry: { entries: ApiEntry[]; indexes?: Record<string, unknown> },
  limit: number = 5
): SuggestedTool[] {
  const keywords = extractKeywords(prompt);

  if (keywords.length === 0) {
    return []; // No meaningful keywords to search for
  }

  // Score all APIs in registry
  const scored = registry.entries.map(api => ({
    api,
    relevance: calculateRelevance(api, keywords),
  }));

  // Filter low-relevance APIs (threshold: 0.2)
  const candidates = scored.filter(s => s.relevance > 0.2);

  // Sort by relevance, then by auth type simplicity (none > apiKey > oauth)
  const authTypeRank = { 'none': 0, 'apiKey': 1, 'oauth': 2, 'other': 3 };
  candidates.sort((a, b) => {
    if (a.relevance !== b.relevance) {
      return b.relevance - a.relevance; // Higher relevance first
    }
    // Tiebreaker: simpler auth types first
    const aAuthRank = authTypeRank[a.api.authType as keyof typeof authTypeRank] ?? 4;
    const bAuthRank = authTypeRank[b.api.authType as keyof typeof authTypeRank] ?? 4;
    return aAuthRank - bAuthRank;
  });

  // Convert to SuggestedTool and return top N
  return candidates.slice(0, limit).map(({ api, relevance }) => ({
    id: api.id,
    name: api.name,
    url: api.url,
    confidence: Number(relevance.toFixed(2)),
    authType: api.authType,
    category: api.category,
    description: api.description,
    domain: api.domain,                                 // Include domain
    baseUrl: deriveBaseUrl(api.url) ?? undefined,
    sampleEndpoint: deriveSampleEndpoint(api) ?? undefined,
  }));
}

/**
 * Derive likely base URL from documentation URL
 *
 * @param docUrl - The documentation URL
 * @returns Guessed API base URL
 *
 * @example
 * deriveBaseUrl('https://stripe.com/docs/api')
 * → 'https://api.stripe.com'
 */
function deriveBaseUrl(docUrl: string): string | undefined {
  try {
    const url = new URL(docUrl);
    const domain = url.hostname.replace(/^www\./, '');

    // Common patterns for API base URLs
    if (domain.includes('github')) return 'https://api.github.com';
    if (domain.includes('stripe')) return 'https://api.stripe.com';
    if (domain.includes('slack')) return 'https://slack.com/api';
    if (domain.includes('twitter')) return 'https://api.twitter.com';
    if (domain.includes('google')) return 'https://www.googleapis.com';

    // Generic pattern: use api subdomain
    if (!domain.startsWith('api.')) {
      return `https://api.${domain}`;
    }

    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Derive likely sample endpoint path
 *
 * @param api - The API entry
 * @returns Sample endpoint path
 *
 * @example
 * deriveSampleEndpoint({ name: 'Stripe', domain: 'stripe.com', ... })
 * → '/v1/charges'
 */
function deriveSampleEndpoint(api: ApiEntry): string | undefined {
  const endpointMap: Record<string, string> = {
    'stripe': '/v1/charges',
    'github': '/repos/{owner}/{repo}',
    'slack': '/api/conversations.list',
    'twitter': '/2/tweets/search/recent',
    'openai': '/v1/chat/completions',
  };

  for (const [domain, endpoint] of Object.entries(endpointMap)) {
    if (api.domain.includes(domain)) {
      return endpoint;
    }
  }

  return undefined;
}

/**
 * Generate a commented step scaffold for a suggested API
 * Includes auth placement, resource limits, and documentation link
 *
 * @param api - The API entry
 * @param stepIndex - Index for step naming
 * @returns YAML-formatted step scaffold with comments
 *
 * @example
 * generateStepScaffold(stripeApi, 1) →
 * `# Generated by arc add-api
 *  # API: Stripe
 *  # Auth: apiKey (set STRIPE_API_KEY)
 *  
 *  - id: stripe_call_1
 *    agent: suggest
 *    prompt: |
 *      Using Stripe API, ...`
 */
export function generateStepScaffold(api: SuggestedTool, stepIndex: number = 1): string {
  const authInstructions = {
    'none': 'No authentication required',
    'apiKey': `Set environment variable: ${api.id.toUpperCase()}_API_KEY`,
    'oauth': `OAuth 2.0 required - Configure redirect URL`,
    'other': 'Custom authentication - See docs',
  };

  const authPlacement = {
    'stripe': 'X-Stripe-Key header',
    'github': 'Authorization: token header',
    'slack': 'Authorization: Bearer header',
    'default': 'apiKey query parameter or header (see docs)',
  };

  const placementKey = Object.keys(authPlacement).find(key => api.domain.includes(key)) || 'default';
  const placement = authPlacement[placementKey as keyof typeof authPlacement];

  const resourceLimits = estimateResourceLimits(api);

  const scaffold = `# ─────────────────────────────────────────────────────────────────
# Generated by: arc add-api ${api.category}/${api.id}
# Timestamp: ${new Date().toISOString()}
# Documentation: ${api.url}
#
# ℹ️  Authentication: ${api.authType}
#    ${authInstructions[api.authType as keyof typeof authInstructions]}
#    Placement: ${placement}
#
# ℹ️  Resource Limits (pre-configured):
#    Memory: ${resourceLimits.memoryMB}MB
#    Timeout: ${resourceLimits.timeoutMs}ms
#    CPU warning: ${resourceLimits.cpuWarnPercent}%
#    Output limit: ${resourceLimits.outputMB}MB
#
# ⚠️  Security Notes:
#    • Credentials will be masked in logs (Layer 7: Secret Masking)
#    • API responses are limited to prevent OOM (Layer 4: Resource Watchdog)
#    • First use requires human approval (Layer 6: Approval Gates)
# ─────────────────────────────────────────────────────────────────

- id: ${api.id}_${stepIndex}
  name: Call ${api.name} API
  agent: suggest
  prompt: |
    Using the ${api.name} API, perform the following task:
    
    [DESCRIBE YOUR TASK HERE]
    
    API Documentation: ${api.url}
    Base URL: ${api.baseUrl || 'See docs'}
    Sample Endpoint: ${api.sampleEndpoint || 'GET /resources'}
    
    Required Authentication: ${api.authType} (set from environment)
    Expected Response: [DESCRIBE EXPECTED RESPONSE FORMAT]
    
    Return the API response or the extracted data in JSON format.
  
  output:
    type: variable
    name: ${api.id}_response
  
  timeout: ${resourceLimits.timeoutMs}
  retries: 2
  
  resources:
    memoryMB: ${resourceLimits.memoryMB}
    cpuWarnPercent: ${resourceLimits.cpuWarnPercent}
    checkIntervalMs: 500
  
  metadata:
    api_id: ${api.id}
    api_name: ${api.name}
    api_auth_type: ${api.authType}
    api_domain: ${api.domain}
    api_documentation: ${api.url}
    generated_by: arc add-api
`;

  return scaffold;
}

/**
 * Estimate appropriate resource limits for an API
 * Based on domain and typical usage patterns
 *
 * @param api - The API entry
 * @returns Resource limit configuration
 */
function estimateResourceLimits(api: SuggestedTool): {
  memoryMB: number;
  timeoutMs: number;
  cpuWarnPercent: number;
  outputMB: number;
} {
  const defaultLimits = {
    memoryMB: 256,
    timeoutMs: 30000,
    cpuWarnPercent: 80,
    outputMB: 2,
  };

  // Domain-specific overrides
  const domainLimits: Record<string, typeof defaultLimits> = {
    'stripe': { memoryMB: 256, timeoutMs: 30000, cpuWarnPercent: 80, outputMB: 2 },
    'github': { memoryMB: 128, timeoutMs: 15000, cpuWarnPercent: 75, outputMB: 1 },
    'openai': { memoryMB: 512, timeoutMs: 120000, cpuWarnPercent: 85, outputMB: 5 },
    'slack': { memoryMB: 256, timeoutMs: 30000, cpuWarnPercent: 80, outputMB: 2 },
    'google': { memoryMB: 512, timeoutMs: 60000, cpuWarnPercent: 80, outputMB: 3 },
  };

  for (const [domain, limits] of Object.entries(domainLimits)) {
    if (api.domain.includes(domain)) {
      return limits;
    }
  }

  return defaultLimits;
}
