import { describe, it, expect, beforeEach } from 'bun:test';
import {
  PlanConverter,
  loadToolCatalog,
  convertPlanToWorkflow,
  type MCPToolSchema,
  type HallucinationAlert,
  type Workflow,
} from '../../src/parsers/plan-converter';
import { ArchitectPlan, ArchitectPlanStep } from '../../src/types/architect';

// Mock tool catalog for testing
const MOCK_CATALOG: MCPToolSchema[] = [
  {
    id: 'filesystem-mcp',
    name: 'Filesystem Tool',
    description: 'Read/write files and directories',
    category: 'file-ops',
    authType: 'none',
    scope: 'full-control',
  },
  {
    id: 'database-mcp',
    name: 'Database Tool',
    description: 'Query and modify databases',
    category: 'database',
    authType: 'api-key',
    scope: 'full-control',
  },
  {
    id: 'http-client-mcp',
    name: 'HTTP Client',
    description: 'Make HTTP requests',
    category: 'networking',
    authType: 'none',
    scope: 'full-control',
  },
  {
    id: 'git-tool',
    name: 'Git Tool',
    description: 'Version control operations',
    category: 'vcs',
    authType: 'oauth2',
    scope: 'full-control',
  },
  {
    id: 'generic-shell',
    name: 'Generic Shell Executor',
    description: 'Execute shell commands as fallback',
    category: 'execution',
    authType: 'none',
    scope: 'full-control',
  },
  {
    id: 'database-postgresql',
    name: 'PostgreSQL Database',
    description: 'PostgreSQL-specific database operations',
    category: 'database',
    authType: 'api-key',
    scope: 'modify',
  },
];

describe('Plan Converter', () => {
  let converter: PlanConverter;

  beforeEach(() => {
    converter = new PlanConverter(MOCK_CATALOG);
  });

  describe('Basic Workflow Conversion', () => {
    it('should convert simple single-step plan to workflow', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-1',
        request_summary: 'Read a configuration file',
        reasoning: 'Need to load app configuration',
        steps: [
          {
            step_id: 0,
            step_name: 'Read Config',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Load configuration from file',
            expected_output: 'JSON configuration object',
            confidence: 0.9,
          },
        ],
        confidence_score: 0.9,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);

      expect(result.success).toBe(true);
      expect(result.workflow.steps).toHaveLength(1);
      expect(result.workflow.steps[0].name).toBe('Read Config');
      expect(result.workflow.steps[0].tools[0].id).toBe('filesystem-mcp');
      expect(result.hallucinations).toHaveLength(0);
    });

    it('should convert multi-step plan with dependencies', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-2',
        request_summary: 'Database migration workflow',
        reasoning: 'Migrate data from old to new database',
        steps: [
          {
            step_id: 0,
            step_name: 'Export Data',
            tool_needed: 'database-mcp',
            reasoning: 'Export data from source database',
            expected_output: 'SQL dump file',
            confidence: 0.9,
          },
          {
            step_id: 1,
            step_name: 'Transform Data',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Apply transformations to exported data',
            expected_output: 'Transformed SQL dump',
            dependencies: [0],
            confidence: 0.85,
          },
          {
            step_id: 2,
            step_name: 'Import Data',
            tool_needed: 'database-postgresql',
            reasoning: 'Import transformed data to new database',
            expected_output: 'Success confirmation',
            dependencies: [1],
            confidence: 0.85,
          },
        ],
        confidence_score: 0.87,
        total_steps: 3,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);

      expect(result.success).toBe(true);
      expect(result.workflow.steps).toHaveLength(3);

      // Verify step names
      expect(result.workflow.steps[0].name).toBe('Export Data');
      expect(result.workflow.steps[1].name).toBe('Transform Data');
      expect(result.workflow.steps[2].name).toBe('Import Data');

      // Verify dependencies
      expect(result.workflow.steps[0].when).toBeUndefined();
      expect(result.workflow.steps[1].when).toContain('step_0_complete');
      expect(result.workflow.steps[2].when).toContain('step_1_complete');

      expect(result.hallucinations).toHaveLength(0);
    });

    it('should generate explicit prompts with reasoning', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-3',
        request_summary: 'API integration',
        reasoning: 'Connect to external API',
        steps: [
          {
            step_id: 0,
            step_name: 'Call API',
            tool_needed: 'http-client-mcp',
            reasoning: 'Make authenticated request to /users endpoint',
            expected_output: 'JSON array of users',
            confidence: 0.92,
          },
        ],
        confidence_score: 0.92,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);
      const prompt = result.workflow.steps[0].prompt;

      expect(prompt).toContain('Execute the following architectural requirement');
      expect(prompt).toContain('Make authenticated request to /users endpoint');
      expect(prompt).toContain('JSON array of users');
      expect(prompt).toContain('HTTP Client');
    });

    it('should inject safety patterns in every step', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-4',
        request_summary: 'Simple task',
        reasoning: 'Do something',
        steps: [
          {
            step_id: 0,
            step_name: 'Task',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Read file',
            confidence: 0.9,
          },
        ],
        confidence_score: 0.9,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);
      const safety = result.workflow.steps[0].safety;

      expect(safety.pattern_scan).toBe(true);
      expect(typeof safety.require_approval).toBe('boolean');
      expect(typeof safety.timeout).toBe('number');
      expect(safety.timeout).toBeGreaterThan(0);
    });
  });

  describe('Tool Validation & Lookup', () => {
    it('should find exact tool match', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-5',
        request_summary: 'Test exact match',
        reasoning: 'Verify exact tool lookup',
        steps: [
          {
            step_id: 0,
            step_name: 'Use Git',
            tool_needed: 'git-tool',
            reasoning: 'Use git for version control',
            confidence: 0.95,
          },
        ],
        confidence_score: 0.95,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);

      expect(result.success).toBe(true);
      expect(result.workflow.steps[0].tools[0].id).toBe('git-tool');
      expect(result.hallucinations).toHaveLength(0);
    });

    it('should reject plan with completely invalid tool', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-6',
        request_summary: 'Test invalid tool',
        reasoning: 'Use non-existent tool',
        steps: [
          {
            step_id: 0,
            step_name: 'Use Magic',
            tool_needed: 'nonexistent-magic-tool-xyz',
            reasoning: 'This tool does not exist anywhere',
            confidence: 0.5,
          },
        ],
        confidence_score: 0.5,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      // Should fall back to generic-shell or fail
      const result = await converter.convert(plan);
      expect(result.success).toBe(true); // Fallback allowed
      expect(result.workflow.steps[0].tools[0].id).toBe('generic-shell');
      expect(result.hallucinations.length).toBeGreaterThan(0);
    });
  });

  describe('Hallucination Detection & Recovery', () => {
    it('should detect and fuzzy-match near-identical tool names', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-7',
        request_summary: 'Fuzzy match test',
        reasoning: 'Test fuzzy matching',
        steps: [
          {
            step_id: 0,
            step_name: 'Use Database',
            tool_needed: 'database-mcp-v2', // Close to 'database-mcp'
            reasoning: 'Access database',
            category: 'database',
            confidence: 0.85,
          },
        ],
        confidence_score: 0.85,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);

      expect(result.success).toBe(true);
      // Should fuzzy match to 'database-mcp' or 'database-postgresql'
      expect(result.hallucinations.length).toBeGreaterThan(0);
      const hallucination = result.hallucinations[0];
      expect(hallucination.action).toMatch(/fuzzy_match|fallback/);
      expect(hallucination.message).toContain('requested');
    });

    it('should categorize hallucinations by confidence', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-8',
        request_summary: 'Category matching test',
        reasoning: 'Test category-based fuzzy matching',
        steps: [
          {
            step_id: 0,
            step_name: 'Database Operation',
            tool_needed: 'databse-mcp', // Typo: 'databse' instead of 'database'
            reasoning: 'Database operation',
            category: 'database',
            confidence: 0.8,
          },
        ],
        confidence_score: 0.8,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);

      expect(result.success).toBe(true);
      if (result.hallucinations.length > 0) {
        const hallucination = result.hallucinations[0];
        expect(hallucination.confidence).toBeLessThanOrEqual(1);
        expect(hallucination.confidence).toBeGreaterThan(0);
      }
    });

    it('should include hallucination warnings in metadata', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-9',
        request_summary: 'Hallucination tracking',
        reasoning: 'Track hallucinations',
        steps: [
          {
            step_id: 0,
            step_name: 'Unknown Tool',
            tool_needed: 'unknown-xyz-tool',
            reasoning: 'Use unknown tool',
            confidence: 0.5,
          },
        ],
        confidence_score: 0.5,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);

      expect(result.workflow.metadata.hallucination_count).toBeGreaterThanOrEqual(
        result.hallucinations.length,
      );
    });
  });

  describe('Dependency Resolution', () => {
    it('should detect circular dependencies and reject', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-10',
        request_summary: 'Circular dependency test',
        reasoning: 'Test circular dependency detection',
        steps: [
          {
            step_id: 0,
            step_name: 'Step A',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Step A',
            dependencies: [1], // A depends on B
            confidence: 0.9,
          },
          {
            step_id: 1,
            step_name: 'Step B',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Step B',
            dependencies: [0], // B depends on A -> CYCLE
            confidence: 0.9,
          },
        ],
        confidence_score: 0.9,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      await expect(converter.convert(plan)).rejects.toThrow(
        /circular/i,
      );
    });

    it('should resolve complex multi-step dependencies', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-11',
        request_summary: 'Complex dependencies',
        reasoning: 'Multi-step with complex deps',
        steps: [
          {
            step_id: 0,
            step_name: 'Setup',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Setup',
            confidence: 0.95,
          },
          {
            step_id: 1,
            step_name: 'Task A',
            tool_needed: 'database-mcp',
            reasoning: 'Task A',
            dependencies: [0],
            confidence: 0.9,
          },
          {
            step_id: 2,
            step_name: 'Task B',
            tool_needed: 'database-mcp',
            reasoning: 'Task B',
            dependencies: [0],
            confidence: 0.9,
          },
          {
            step_id: 3,
            step_name: 'Finalize',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Finalize',
            dependencies: [1, 2],
            confidence: 0.95,
          },
        ],
        confidence_score: 0.92,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);

      expect(result.success).toBe(true);
      expect(result.workflow.steps).toHaveLength(4);

      // Verify dependency chain
      expect(result.workflow.steps[0].when).toBeUndefined();
      expect(result.workflow.steps[1].when).toContain('step_0');
      expect(result.workflow.steps[2].when).toContain('step_0');
      expect(result.workflow.steps[3].when).toContain('step_1');
      expect(result.workflow.steps[3].when).toContain('step_2');
    });
  });

  describe('Workflow Validation', () => {
    it('should validate complete workflow structure', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-12',
        request_summary: 'Valid workflow',
        reasoning: 'Create valid workflow',
        steps: [
          {
            step_id: 0,
            step_name: 'Step',
            tool_needed: 'http-client-mcp',
            reasoning: 'Do something',
            confidence: 0.9,
          },
        ],
        confidence_score: 0.9,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);

      expect(result.success).toBe(true);
      expect(result.workflow.name).toBeDefined();
      expect(result.workflow.steps).toBeDefined();
      expect(result.workflow.metadata).toBeDefined();
      expect(result.workflow.metadata.architect_plan_id).toBe('test-12');
    });

    it('should reject empty workflow', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-13',
        request_summary: 'Empty workflow',
        reasoning: 'This should fail',
        steps: [],
        confidence_score: 0.0,
        total_steps: 0,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      await expect(converter.convert(plan)).rejects.toThrow(
        /at least one step/i,
      );
    });
  });

  describe('Safety Integration', () => {
    it('should require approval for tools with auth', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-14',
        request_summary: 'Auth tool test',
        reasoning: 'Test auth requirement',
        steps: [
          {
            step_id: 0,
            step_name: 'Database Access',
            tool_needed: 'database-mcp', // Requires API key
            reasoning: 'Access database',
            confidence: 0.9,
          },
        ],
        confidence_score: 0.9,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);
      const safety = result.workflow.steps[0].safety;

      expect(safety.require_approval).toBe(true); // API key required
    });

    it('should require approval for modifying tools even without authentication', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-15',
        request_summary: 'Open tool test',
        reasoning: 'Test approval not needed',
        steps: [
          {
            step_id: 0,
            step_name: 'HTTP Request',
            tool_needed: 'http-client-mcp', // No auth required
            reasoning: 'Make HTTP request',
            confidence: 0.9,
          },
        ],
        confidence_score: 0.9,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);
      const safety = result.workflow.steps[0].safety;

      expect(safety.require_approval).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing step properties gracefully', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-16',
        request_summary: 'Minimal step',
        reasoning: 'Test minimal step',
        steps: [
          {
            step_id: 0,
            step_name: 'Minimal',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Minimal step with no expected output',
            // no expected_output
            confidence: 0.8,
          },
        ],
        confidence_score: 0.8,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);

      expect(result.success).toBe(true);
      expect(result.workflow.steps[0].expected_output).toBeUndefined();
    });

    it('should preserve confidence scores in metadata', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'test-17',
        request_summary: 'Confidence test',
        reasoning: 'Test confidence scores',
        steps: [
          {
            step_id: 0,
            step_name: 'Task',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Task',
            confidence: 0.75,
          },
        ],
        confidence_score: 0.75,
        total_steps: 1,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);

      expect(result.workflow.metadata.confidence_score).toBe(0.75);
      expect(result.workflow.steps[0].metadata.confidence_score).toBe(0.75);
    });
  });

  describe('Integration Scenarios', () => {
    it('should convert realistic multi-step deployment workflow', async () => {
      const plan: ArchitectPlan = {
        plan_id: 'deploy-001',
        request_summary: 'Deploy application to production',
        reasoning: 'Automated deployment pipeline',
        steps: [
          {
            step_id: 0,
            step_name: 'Clone Repository',
            tool_needed: 'git-tool',
            reasoning: 'Clone latest code from main branch',
            expected_output: 'Code repository cloned locally',
            confidence: 0.95,
          },
          {
            step_id: 1,
            step_name: 'Run Tests',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Execute test suite to verify functionality',
            expected_output: 'Test results and coverage report',
            dependencies: [0],
            confidence: 0.9,
          },
          {
            step_id: 2,
            step_name: 'Build Artifacts',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Compile and build deployment artifacts',
            expected_output: 'Built application files',
            dependencies: [1],
            confidence: 0.92,
          },
          {
            step_id: 3,
            step_name: 'Deploy to Production',
            tool_needed: 'http-client-mcp',
            reasoning: 'Push built artifacts to production server',
            expected_output: 'Deployment confirmation',
            dependencies: [2],
            confidence: 0.88,
          },
        ],
        confidence_score: 0.91,
        total_steps: 4,
        estimated_tokens: 0,
        approval_required: false,
        risks: [],
        execution_order: [],
        timestamp: '2024-01-01',
      };

      const result = await converter.convert(plan);

      expect(result.success).toBe(true);
      expect(result.workflow.steps).toHaveLength(4);
      expect(result.workflow.name).toContain('production');
      expect(result.hallucinations).toHaveLength(0);

      // Verify complete dependency chain
      expect(result.workflow.steps[3].when).toContain('step_2');
    });
  });
});
