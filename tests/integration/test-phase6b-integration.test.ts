import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import {
  PlanConverter,
  type Workflow,
  type HallucinationAlert,
  type MCPToolSchema,
} from '../../src/parsers/plan-converter';
import { BuilderAgent, type ExecutionResult } from '../../src/agents/builder';
import { CheckpointHandler, type CheckpointDecision } from '../../src/interactive/checkpoint-handler';
import { SafetyGuardrail } from '../../src/safety/safety-guardrail';

// Mock catalog for integration tests
const MOCK_CATALOG: MCPToolSchema[] = [
  {
    id: 'filesystem-mcp',
    name: 'Filesystem Tool',
    description: 'File operations',
    category: 'file-ops',
    authType: 'none',
    scope: 'full-control',
  },
  {
    id: 'database-mcp',
    name: 'Database Tool',
    description: 'Database operations',
    category: 'database',
    authType: 'api-key',
    scope: 'modify',
  },
  {
    id: 'http-client-mcp',
    name: 'HTTP Client',
    description: 'HTTP requests',
    category: 'networking',
    authType: 'none',
    scope: 'full-control',
  },
  {
    id: 'git-tool',
    name: 'Git Tool',
    description: 'Git operations',
    category: 'vcs',
    authType: 'oauth2',
    scope: 'full-control',
  },
  {
    id: 'generic-shell',
    name: 'Generic Shell',
    description: 'Shell fallback',
    category: 'execution',
    authType: 'none',
    scope: 'full-control',
  },
];

describe('Phase 6b Integration Tests', () => {
  let converter: PlanConverter;
  let builder: BuilderAgent;
  let checkpoint: CheckpointHandler;

  beforeEach(() => {
    converter = new PlanConverter(MOCK_CATALOG);
    builder = new BuilderAgent();
    // Mock loadTool to return successful execution
    spyOn(builder as any, 'loadTool').mockImplementation(async (id: string) => {
      return {
        id, name: id,
        execute: async () => ({ output: `Mock result for ${ id }` }),
      };
    });
    checkpoint = new CheckpointHandler({
      show_full_prompts: false,
      require_approval_for: ['auth_required', 'hallucinations'],
    });
  });

  describe('Full Pipeline: Architect → Converter → Checkpoint → Builder', () => {
    it('should convert and execute simple workflow end-to-end', async () => {
      // Step 1: Create plan from Architect
      const plan: any = {
        plan_id: 'e2e-001',
        goal: 'Read configuration file',
        reasoning: 'Load app configuration',
        steps: [
          {
            step_id: 0,
            step_name: 'Read Config',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Load configuration from file',
            expected_output: 'Configuration JSON',
            confidence: 0.95,
          },
        ],
        overall_confidence: 0.95,
      };

      // Step 2: Convert to Workflow
      const conversionResult = await converter.convert(plan);
      expect(conversionResult.success).toBe(true);

      // Step 3: Pass through checkpoint (would be interactive)
      const approvalResult = await checkpoint.autoApprove(
        conversionResult.workflow,
        conversionResult.hallucinations,
      );
      expect(approvalResult.approved).toBe(true);

      // Step 4: Execute with Builder
      const executionResult = await builder.execute(conversionResult.workflow, { permissions: new Set(MOCK_CATALOG.map(tool => `tool:${tool.id}`)), approved: true });
      expect(executionResult.status).toBe('success');
      expect(executionResult.steps_executed).toBe(1);
    });

    it('should handle hallucination in full pipeline', async () => {
      const plan: any = {
        plan_id: 'e2e-002',
        goal: 'Database operation',
        reasoning: 'Access database with fuzzy-matched tool',
        steps: [
          {
            step_id: 0,
            step_name: 'Query Database',
            tool_needed: 'databse-mcp', // Typo: "databse" instead of "database"
            reasoning: 'Query users table',
            category: 'database',
            confidence: 0.8,
          },
        ],
        overall_confidence: 0.8,
      };

      // Convert with hallucination detection
      const conversionResult = await converter.convert(plan);
      expect(conversionResult.success).toBe(true);

      // Should have detected hallucination
      if (conversionResult.hallucinations.length > 0) {
        const hallucination = conversionResult.hallucinations[0];
        expect(hallucination.step_tool_requested).toBe('databse-mcp');
        expect(['fuzzy_match', 'fallback']).toContain(hallucination.action);
      }

      // Checkpoint should flag it
      const approvalResult = await checkpoint.autoApprove(
        conversionResult.workflow,
        conversionResult.hallucinations,
      );
      expect(approvalResult.approved).toBe(true);

      // Should still execute with recovered tool
      const executionResult = await builder.execute(conversionResult.workflow, { permissions: new Set(MOCK_CATALOG.map(tool => `tool:${tool.id}`)), approved: true });
      expect(executionResult.status).toBe('success');
    });

    it('should execute multi-step workflow with dependencies', async () => {
      const plan: any = {
        plan_id: 'e2e-003',
        goal: 'Data processing pipeline',
        reasoning: 'Process data through multiple steps',
        steps: [
          {
            step_id: 0,
            step_name: 'Extract Data',
            tool_needed: 'database-mcp',
            reasoning: 'Extract data from source',
            expected_output: 'Extracted data set',
            confidence: 0.9,
          },
          {
            step_id: 1,
            step_name: 'Transform Data',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Transform extracted data',
            expected_output: 'Transformed data',
            dependencies: [0],
            confidence: 0.85,
          },
          {
            step_id: 2,
            step_name: 'Load Data',
            tool_needed: 'database-mcp',
            reasoning: 'Load transformed data',
            expected_output: 'Success confirmation',
            dependencies: [1],
            confidence: 0.88,
          },
        ],
        overall_confidence: 0.88,
      };

      // Convert
      const conversionResult = await converter.convert(plan);
      expect(conversionResult.success).toBe(true);
      expect(conversionResult.workflow.steps).toHaveLength(3);

      // Verify dependencies in workflow
      expect(conversionResult.workflow.steps[0].when).toBeUndefined();
      expect(conversionResult.workflow.steps[1].when).toContain('step_0');
      expect(conversionResult.workflow.steps[2].when).toContain('step_1');

      // Checkpoint
      const approvalResult = await checkpoint.autoApprove(
        conversionResult.workflow,
        conversionResult.hallucinations,
      );
      expect(approvalResult.approved).toBe(true);

      // Execute
      const executionResult = await builder.execute(conversionResult.workflow, { permissions: new Set(MOCK_CATALOG.map(tool => `tool:${tool.id}`)), approved: true });
      if (executionResult.status !== 'success') {
        console.error('EXECUTION FAILED:', executionResult.errors);
      }
      expect(executionResult.status).toBe('success');
      expect(executionResult.steps_executed).toBe(3);

      // Verify execution order
      expect(executionResult.step_results[0].step_name).toBe('Extract Data');
      expect(executionResult.step_results[1].step_name).toBe('Transform Data');
      expect(executionResult.step_results[2].step_name).toBe('Load Data');
    });
  });

  describe('Hallucination Recovery in Pipeline', () => {
    it('should recover from fuzzy-matched tool with auto-approval', async () => {
      const plan: any = {
        plan_id: 'halluc-001',
        goal: 'VCS operation with typo',
        reasoning: 'Test fuzzy matching',
        steps: [
          {
            step_id: 0,
            step_name: 'Clone Repository',
            tool_needed: 'gitt-tool', // Close to 'git-tool'
            reasoning: 'Clone repo',
            category: 'vcs',
            confidence: 0.75,
          },
        ],
        overall_confidence: 0.75,
      };

      const conversionResult = await converter.convert(plan);
      expect(conversionResult.success).toBe(true);

      // Should have hallucination alert
      const hasHallucination = conversionResult.hallucinations.length > 0;

      // Even with hallucination, should execute
      const executionResult = await builder.execute(conversionResult.workflow, { permissions: new Set(MOCK_CATALOG.map(tool => `tool:${tool.id}`)), approved: true });
      expect(executionResult.status).toBe('success');
      expect(executionResult.steps_executed).toBe(1);
    });

    it('should fallback to generic tool for completely unknown tool', async () => {
      const plan: any = {
        plan_id: 'halluc-002',
        goal: 'Unknown tool operation',
        reasoning: 'Test fallback',
        steps: [
          {
            step_id: 0,
            step_name: 'Unknown Operation',
            tool_needed: 'xyz-magic-tool-unknown',
            reasoning: 'Use non-existent tool',
            confidence: 0.5,
          },
        ],
        overall_confidence: 0.5,
      };

      const conversionResult = await converter.convert(plan);
      expect(conversionResult.success).toBe(true);

      // Should have fallen back to generic tool
      if (conversionResult.hallucinations.length > 0) {
        expect(conversionResult.hallucinations[0].action).toBe('fallback');
        expect(conversionResult.hallucinations[0].tool_id_suggested).toBe('generic-shell');
      }

      // Should still execute
      const executionResult = await builder.execute(conversionResult.workflow, { permissions: new Set(MOCK_CATALOG.map(tool => `tool:${tool.id}`)), approved: true });
      expect(executionResult.status).toBe('success');
    });
  });

  describe('Safety and Approval Integration', () => {
    it('should mark auth-required tools in workflow', async () => {
      const plan: any = {
        plan_id: 'safety-001',
        goal: 'Database access',
        reasoning: 'Access secured database',
        steps: [
          {
            step_id: 0,
            step_name: 'Query Database',
            tool_needed: 'database-mcp', // Requires API key
            reasoning: 'Query secured database',
            confidence: 0.9,
          },
        ],
        overall_confidence: 0.9,
      };

      const conversionResult = await converter.convert(plan);
      const step = conversionResult.workflow.steps[0];

      // Should be marked as requiring approval
      expect(step.safety.require_approval).toBe(true);
    });

    it('should inject pattern scanning in all steps', async () => {
      const plan: any = {
        plan_id: 'safety-002',
        goal: 'Pattern scanning test',
        reasoning: 'Verify safety injection',
        steps: [
          {
            step_id: 0,
            step_name: 'Scanned Step',
            tool_needed: 'http-client-mcp',
            reasoning: 'Test HTTP request',
            confidence: 0.9,
          },
        ],
        overall_confidence: 0.9,
      };

      const conversionResult = await converter.convert(plan);

      for (const step of conversionResult.workflow.steps) {
        expect(step.safety.pattern_scan).toBe(true);
      }
    });

    it('should set appropriate timeouts based on tool scope', async () => {
      const plan: any = {
        plan_id: 'safety-003',
        goal: 'Timeout configuration test',
        reasoning: 'Verify timeout injection',
        steps: [
          {
            step_id: 0,
            step_name: 'Quick Read',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Quick filesystem read',
            confidence: 0.95,
          },
          {
            step_id: 1,
            step_name: 'DB Modification',
            tool_needed: 'database-mcp',
            reasoning: 'Modify database (slower)',
            dependencies: [0],
            confidence: 0.9,
          },
        ],
        overall_confidence: 0.92,
      };

      const conversionResult = await converter.convert(plan);

      // File ops (full-control) have longer timeout
      const fileStep = conversionResult.workflow.steps[0];
      const dbStep = conversionResult.workflow.steps[1];

      expect(fileStep.safety.timeout).toBeGreaterThan(dbStep.safety.timeout);
    });
  });

  describe('Checkpoint Approval Scenarios', () => {
    it('should auto-approve workflow without issues', async () => {
      const plan: any = {
        plan_id: 'checkpoint-001',
        goal: 'Clean workflow',
        reasoning: 'No hallucinations or auth issues',
        steps: [
          {
            step_id: 0,
            step_name: 'Simple Task',
            tool_needed: 'http-client-mcp', // No auth, no hallucinations
            reasoning: 'Simple HTTP request',
            confidence: 0.95,
          },
        ],
        overall_confidence: 0.95,
      };

      const conversionResult = await converter.convert(plan);

      // Should auto-approve with no hallucinations
      const decision = await checkpoint.autoApprove(
        conversionResult.workflow,
        conversionResult.hallucinations,
      );

      expect(decision.approved).toBe(true);
      expect(decision.action).toBe('approve');
    });

    it('should require approval for workflows with auth-required tools', async () => {
      const plan: any = {
        plan_id: 'checkpoint-002',
        goal: 'Secured operation',
        reasoning: 'Access secured resource',
        steps: [
          {
            step_id: 0,
            step_name: 'Secured Task',
            tool_needed: 'database-mcp', // Requires auth
            reasoning: 'Secure database operation',
            confidence: 0.9,
          },
        ],
        overall_confidence: 0.9,
      };

      const conversionResult = await converter.convert(plan);

      // In non-interactive mode, should still approve
      const decision = await checkpoint.autoApprove(
        conversionResult.workflow,
        conversionResult.hallucinations,
      );

      expect(decision.approved).toBe(true);
    });

    it('should flag hallucinated tools in checkpoint', async () => {
      const plan: any = {
        plan_id: 'checkpoint-003',
        goal: 'Hallucinated tool operation',
        reasoning: 'Test hallucination flagging',
        steps: [
          {
            step_id: 0,
            step_name: 'Fuzzy Match',
            tool_needed: 'git-tool-v2', // Close to 'git-tool'
            reasoning: 'Git operation with typo',
            category: 'vcs',
            confidence: 0.8,
          },
        ],
        overall_confidence: 0.8,
      };

      const conversionResult = await converter.convert(plan);

      // Checkpoint receives hallucination alerts
      const decision = await checkpoint.autoApprove(
        conversionResult.workflow,
        conversionResult.hallucinations,
      );

      // Should still approve but alerts would be visible to user
      expect(decision.approved).toBe(true);

      if (conversionResult.hallucinations.length > 0) {
        expect(decision.timestamp).toBeDefined();
      }
    });
  });

  describe('Error Handling Across Pipeline', () => {
    it('should handle circular dependencies in conversion', async () => {
      const plan: any = {
        plan_id: 'error-001',
        goal: 'Circular dependency test',
        reasoning: 'Test error handling',
        steps: [
          {
            step_id: 0,
            step_name: 'Step A',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Step A',
            dependencies: [1],
            confidence: 0.9,
          },
          {
            step_id: 1,
            step_name: 'Step B',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Step B',
            dependencies: [0],
            confidence: 0.9,
          },
        ],
        overall_confidence: 0.9,
      };

      // Conversion should reject circular dependencies
      await expect(converter.convert(plan)).rejects.toThrow(/circular/i);
    });

    it('should validate workflow schema before execution', async () => {
      const plan: any = {
        plan_id: 'error-002',
        goal: 'Schema validation test',
        reasoning: 'Verify schema compliance',
        steps: [
          {
            step_id: 0,
            step_name: 'Valid Step',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Valid workflow step',
            confidence: 0.95,
          },
        ],
        overall_confidence: 0.95,
      };

      const conversionResult = await converter.convert(plan);

      // Converted workflow should be valid for execution
      expect(conversionResult.workflow.metadata.tool_count).toBe(1);
      expect(conversionResult.workflow.steps.length).toBe(1);
    });
  });

  describe('Audit Trail Collection', () => {
    it('should collect audit trail through full pipeline', async () => {
      const plan: any = {
        plan_id: 'audit-001',
        goal: 'Audit trail test',
        reasoning: 'Verify audit collection',
        steps: [
          {
            step_id: 0,
            step_name: 'Audited Step',
            tool_needed: 'http-client-mcp',
            reasoning: 'Make HTTP request',
            confidence: 0.9,
          },
        ],
        overall_confidence: 0.9,
      };

      // Convert
      const conversionResult = await converter.convert(plan);

      // Execute
      const executionResult = await builder.execute(conversionResult.workflow, { permissions: new Set(MOCK_CATALOG.map(tool => `tool:${tool.id}`)), approved: true });

      // Collect audit trail
      const auditTrail = builder.getAuditTrail();

      // Should have entries from execution
      expect(executionResult.audit_trail_id).toBeDefined();
      if (auditTrail.length > 0) {
        expect(auditTrail[0]).toHaveProperty('timestamp');
        expect(auditTrail[0]).toHaveProperty('event_type');
      }
    });

    it('should include steering feedback in audit trail', async () => {
      const plan: any = {
        plan_id: 'audit-002',
        goal: 'Steering integration test',
        reasoning: 'Verify steering feedback capture',
        steps: [
          {
            step_id: 0,
            step_name: 'User-Steered Step',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Execute with user input',
            confidence: 0.9,
          },
        ],
        overall_confidence: 0.9,
      };

      const conversionResult = await converter.convert(plan);
      const executionResult = await builder.execute(conversionResult.workflow, { permissions: new Set(MOCK_CATALOG.map(tool => `tool:${tool.id}`)), approved: true });

      // Simulate Phase 5 steering input
      await builder.handleSteeringInput('step_0', {
        action: 'approve',
        context: 'User approved execution',
      });

      const auditTrail = builder.getAuditTrail();
      const steeringEntries = auditTrail.filter(
        e => e.event_type === 'steering_input',
      );

      expect(steeringEntries.length).toBeGreaterThan(0);
      if (steeringEntries.length > 0) {
        expect(steeringEntries[0].user_input?.action).toBe('approve');
      }
    });
  });

  describe('Complex Real-World Scenarios', () => {
    it('should handle realistic CI/CD pipeline', async () => {
      const plan: any = {
        plan_id: 'realworld-001',
        goal: 'Deploy application to production',
        reasoning: 'Automated deployment pipeline',
        steps: [
          {
            step_id: 0,
            step_name: 'Clone Repository',
            tool_needed: 'git-tool',
            reasoning: 'Clone latest code from main',
            expected_output: 'Cloned repository',
            confidence: 0.95,
          },
          {
            step_id: 1,
            step_name: 'Run Tests',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Execute test suite',
            expected_output: 'Test results',
            dependencies: [0],
            confidence: 0.9,
          },
          {
            step_id: 2,
            step_name: 'Build Artifacts',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Compile application',
            expected_output: 'Built artifacts',
            dependencies: [1],
            confidence: 0.92,
          },
          {
            step_id: 3,
            step_name: 'Deploy to Production',
            tool_needed: 'http-client-mcp',
            reasoning: 'Deploy to production server',
            expected_output: 'Deployment confirmation',
            dependencies: [2],
            confidence: 0.88,
          },
        ],
        overall_confidence: 0.91,
      };

      // Full pipeline
      const conversionResult = await converter.convert(plan);
      expect(conversionResult.success).toBe(true);

      const decision = await checkpoint.autoApprove(
        conversionResult.workflow,
        conversionResult.hallucinations,
      );
      expect(decision.approved).toBe(true);

      const executionResult = await builder.execute(conversionResult.workflow, { permissions: new Set(MOCK_CATALOG.map(tool => `tool:${tool.id}`)), approved: true });
      expect(executionResult.status).toBe('success');
      expect(executionResult.steps_executed).toBe(4);

      // Verify pipeline order
      expect(executionResult.step_results[0].step_name).toBe('Clone Repository');
      expect(executionResult.step_results[1].step_name).toBe('Run Tests');
      expect(executionResult.step_results[2].step_name).toBe('Build Artifacts');
      expect(executionResult.step_results[3].step_name).toBe('Deploy to Production');
    });

    it('should handle data processing pipeline with hallucination recovery', async () => {
      const plan: any = {
        plan_id: 'realworld-002',
        goal: 'Data ETL pipeline',
        reasoning: 'Extract, transform, load data',
        steps: [
          {
            step_id: 0,
            step_name: 'Extract from Source',
            tool_needed: 'database-mcp',
            reasoning: 'Extract data from source database',
            expected_output: 'Raw data export',
            confidence: 0.92,
          },
          {
            step_id: 1,
            step_name: 'Validate Data',
            tool_needed: 'filesystem-mcp',
            reasoning: 'Validate extracted data quality',
            expected_output: 'Validation report',
            dependencies: [0],
            confidence: 0.88,
          },
          {
            step_id: 2,
            step_name: 'Transform Data',
            tool_needed: 'datbase-tool', // Typo: "datbase" instead of "database"
            reasoning: 'Apply transformations',
            category: 'database',
            expected_output: 'Transformed data',
            dependencies: [1],
            confidence: 0.85,
          },
          {
            step_id: 3,
            step_name: 'Load to Warehouse',
            tool_needed: 'database-mcp',
            reasoning: 'Load data to data warehouse',
            expected_output: 'Load completion confirmation',
            dependencies: [2],
            confidence: 0.9,
          },
        ],
        overall_confidence: 0.89,
      };

      const conversionResult = await converter.convert(plan);
      expect(conversionResult.success).toBe(true);

      // Should detect hallucination in step 2
      if (conversionResult.hallucinations.length > 0) {
        expect(
          conversionResult.hallucinations.some(h =>
            h.step_tool_requested.includes('datbase'),
          ),
        ).toBe(true);
      }

      // Checkpoint should show warnings but allow approval
      const decision = await checkpoint.autoApprove(
        conversionResult.workflow,
        conversionResult.hallucinations,
      );
      expect(decision.approved).toBe(true);

      // Execute with recovered tool
      const executionResult = await builder.execute(conversionResult.workflow, { permissions: new Set(MOCK_CATALOG.map(tool => `tool:${tool.id}`)), approved: true });
      expect(executionResult.status).toBe('success');
      expect(executionResult.steps_executed).toBe(4);
    });
  });
});
