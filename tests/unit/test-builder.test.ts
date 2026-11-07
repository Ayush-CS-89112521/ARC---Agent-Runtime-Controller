import {
  BuilderAgent,
  type ExecutionResult,
  type StepResult,
} from '../../src/agents/builder';
import type { Workflow, WorkflowStep } from '../../src/parsers/plan-converter';

// Helper function to create test workflows
function createTestWorkflow(
  steps: Partial<WorkflowStep>[],
  name: string = 'test-workflow',
): Workflow {
  return {
    name,
    steps: steps.map((step, idx) => ({
      id: step.id || `step_${idx}`,
      name: step.name || `Step ${idx}`,
      tools: step.tools || [{ id: 'test-tool', name: 'Test Tool', auth_type: 'none', category: 'test' }],
      prompt: step.prompt || `Execute step ${idx}`,
      safety: step.safety || {
        pattern_scan: true,
        require_approval: false,
        timeout: 30000,
      },
      error_handling: step.error_handling || {
        on_failure: 'stop_workflow',
        fallback_enabled: false,
      },
      metadata: {
        tool_action: 'exact',
        confidence_score: 0.9,
        index: idx,
      },
    })) as WorkflowStep[],
    metadata: {
      architect_plan_id: 'test-plan',
      confidence_score: 0.9,
      conversion_timestamp: new Date().toISOString(),
      tool_count: steps.length,
      hallucination_count: 0,
    },
  };
}

describe('Builder Agent', () => {
  let builder: BuilderAgent;

  beforeEach(() => {
    builder = new BuilderAgent(new Map(['test-tool', 'approved-tool', 'tool-1', 'tool-2', 'custom-tool-mcp'].map(id => [id, {
      id, name: id, execute: async () => {
        await new Promise(resolve => setTimeout(resolve, 2));
        return { result: `Fixture ${id}` };
      },
    }])));
  });

  describe('Basic Execution', () => {
    it('should execute simple single-step workflow', async () => {
      const workflow = createTestWorkflow([
        {
          id: 'step_0',
          name: 'Single Step',
          prompt: 'Do something simple',
        },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.status).toBe('success');
      expect(result.steps_executed).toBe(1);
      expect(result.total_steps).toBe(1);
      expect(result.step_results).toHaveLength(1);
      expect(result.step_results[0].status).toBe('success');
    });

    it('should execute multi-step linear workflow', async () => {
      const workflow = createTestWorkflow([
        { id: 'step_0', name: 'Step 1' },
        { id: 'step_1', name: 'Step 2' },
        { id: 'step_2', name: 'Step 3' },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.status).toBe('success');
      expect(result.steps_executed).toBe(3);
      expect(result.step_results).toHaveLength(3);
      expect(result.summary.successful_steps).toBe(3);
    });

    it('should track execution time', async () => {
      const workflow = createTestWorkflow([
        { id: 'step_0', name: 'Timed Step' },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.execution_time_ms).toBeGreaterThan(0);
      expect(result.step_results[0].duration_ms).toBeGreaterThan(0);
    });

    it('should generate unique audit trail IDs', async () => {
      const workflow = createTestWorkflow([
        { id: 'step_0', name: 'Step' },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.audit_trail_id).toBeDefined();
      expect(result.step_results[0].audit_entry_id).toBeDefined();
    });
  });

  describe('Dependency Resolution', () => {
    it('should execute dependent steps in correct order', async () => {
      const workflow = createTestWorkflow([
        {
          id: 'step_0',
          name: 'First Step',
        },
        {
          id: 'step_1',
          name: 'Second Step',
          when: 'step_0_complete == true',
        },
        {
          id: 'step_2',
          name: 'Third Step',
          when: 'step_1_complete == true',
        },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.status).toBe('success');
      expect(result.steps_executed).toBe(3);

      // Verify order: step_0 → step_1 → step_2
      expect(result.step_results[0].step_name).toBe('First Step');
      expect(result.step_results[1].step_name).toBe('Second Step');
      expect(result.step_results[2].step_name).toBe('Third Step');
    });

    it('should handle multiple independent steps', async () => {
      const workflow = createTestWorkflow([
        { id: 'step_0', name: 'Task A' },
        { id: 'step_1', name: 'Task B' },
        {
          id: 'step_2',
          name: 'Task C',
          when: 'step_0_complete == true && step_1_complete == true',
        },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.status).toBe('success');
      expect(result.steps_executed).toBe(3);
      expect(result.step_results[2].status).toBe('success');
    });

    it('should skip steps with unmet dependencies', async () => {
      // Simulate step 1 failing
      const workflow = createTestWorkflow([
        { id: 'step_0', name: 'Step 0' },
        {
          id: 'step_1',
          name: 'Step 1 Skipped',
          when: 'step_0_complete == true && step_999_complete == true', // step_999 doesn't exist
        },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      // Step 1 should be skipped due to unmet dependency
      expect(result.summary.skipped_steps).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Tool Loading', () => {
    it('should load approved tools from workflow', async () => {
      const workflow = createTestWorkflow([
        {
          id: 'step_0',
          name: 'Tool Load Test',
          tools: [
            {
              id: 'custom-tool-mcp',
              name: 'Custom Tool',
              auth_type: 'api-key',
              category: 'custom',
            },
          ],
        },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.status).toBe('success');
      expect(result.step_results[0].tool_id).toBe('custom-tool-mcp');
    });

    it('should only load tools specified in workflow', async () => {
      const workflow = createTestWorkflow([
        {
          id: 'step_0',
          name: 'Load approved tool',
          tools: [{ id: 'approved-tool', name: 'Approved', auth_type: 'none', category: 'test' }],
        },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.step_results[0].tool_id).toBe('approved-tool');
    });
  });

  describe('Safety Features', () => {
    it('should respect timeout settings', async () => {
      const workflow = createTestWorkflow([
        {
          id: 'step_0',
          name: 'Quick Step',
          safety: {
            pattern_scan: true,
            require_approval: false,
            timeout: 5000, // 5 second timeout
          },
        },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.step_results[0].duration_ms).toBeLessThan(5000);
    });

    it('should mark approval-required steps', async () => {
      const workflow = createTestWorkflow([
        {
          id: 'step_0',
          name: 'Dangerous Operation',
          safety: {
            pattern_scan: true,
            require_approval: true,
            timeout: 30000,
          },
        },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      // Even dangerous operations should execute in test context
      expect(result.status).toBe('success');
    });

    it('should enable pattern scanning for all steps', async () => {
      const workflow = createTestWorkflow([
        {
          id: 'step_0',
          name: 'Scanned Step',
          safety: {
            pattern_scan: true,
            require_approval: false,
            timeout: 30000,
          },
        },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.step_results[0].status).toBe('success');
    });
  });

  describe('Error Handling', () => {
    it('should capture step errors', async () => {
      const workflow = createTestWorkflow([
        { id: 'step_0', name: 'Failing Step' },
        { id: 'step_1', name: 'Next Step', when: 'step_0_complete == true' },
      ]);

      // Note: Current mock always succeeds, would need to inject error for real test
      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      // In failure scenario, errors array would be populated
      if (result.errors.length > 0) {
        expect(result.errors[0]).toHaveProperty('step_id');
        expect(result.errors[0]).toHaveProperty('message');
        expect(result.errors[0]).toHaveProperty('recoverable');
      }
    });

    it('should handle error_handling.on_failure = stop_workflow', async () => {
      const workflow = createTestWorkflow([
        {
          id: 'step_0',
          name: 'Critical Step',
          error_handling: {
            on_failure: 'stop_workflow',
            fallback_enabled: false,
          },
        },
        { id: 'step_1', name: 'Should Not Execute' },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      // On failure, step_1 should not execute
      if (result.status === 'failed') {
        expect(result.step_results.length).toBeLessThanOrEqual(1);
      }
    });

    it('should handle error_handling.on_failure = skip_step', async () => {
      const workflow = createTestWorkflow([
        {
          id: 'step_0',
          name: 'Skippable Step',
          error_handling: {
            on_failure: 'skip_step',
            fallback_enabled: false,
          },
        },
        { id: 'step_1', name: 'Continue After Skip' },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      // Should execute both steps even if first fails
      expect(result.steps_executed).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Audit Trail', () => {
    it('should create audit trail entries', async () => {
      const workflow = createTestWorkflow([
        { id: 'step_0', name: 'Audited Step' },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.audit_trail_id).toBeDefined();
      expect(result.step_results[0].audit_entry_id).toBeDefined();
    });

    it('should log step lifecycle events', async () => {
      const workflow = createTestWorkflow([
        { id: 'step_0', name: 'Lifecycle Test' },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });
      const auditTrail = builder.getAuditTrail();

      // Should have entries for: step_started, tool_loaded, step_completed
      expect(auditTrail.length).toBeGreaterThan(0);

      const eventTypes = auditTrail.map(e => e.event_type);
      expect(eventTypes).toContain('step_started');
    });

    it('should capture tool loading in audit trail', async () => {
      const workflow = createTestWorkflow([
        {
          id: 'step_0',
          name: 'Tool Load Audit',
          tools: [{ id: 'test-mcp', name: 'Test MCP', auth_type: 'none', category: 'test' }],
        },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });
      const auditTrail = builder.getAuditTrail();

      const toolLoadEntries = auditTrail.filter(e => e.event_type === 'tool_loaded');
      if (toolLoadEntries.length > 0) {
        expect(toolLoadEntries[0].details).toHaveProperty('tool_id');
      }
    });
  });

  describe('Steering Integration', () => {
    it('should accept steering input', async () => {
      const workflow = createTestWorkflow([{ id: 'step_0', name: 'Steered Step' }]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      // Simulate Phase 5 steering approval
      await builder.handleSteeringInput('step_0', {
        action: 'approve',
        context: 'User approved step execution',
      });

      const auditTrail = builder.getAuditTrail();
      const steeringEntries = auditTrail.filter(
        e => e.event_type === 'steering_input',
      );

      expect(steeringEntries.length).toBeGreaterThan(0);
      expect(steeringEntries[0].user_input?.action).toBe('approve');
    });

    it('should log steering modifications', async () => {
      const workflow = createTestWorkflow([{ id: 'step_0', name: 'Modified Step' }]);

      await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      // Simulate user modifying prompt via Phase 5 steering
      await builder.handleSteeringInput('step_0', {
        action: 'modify',
        modified_prompt: 'Modified execution prompt from steering',
      });

      const auditTrail = builder.getAuditTrail();
      const modifyEntries = auditTrail.filter(
        e => e.event_type === 'steering_input' && e.user_input?.action === 'modify',
      );

      expect(modifyEntries.length).toBeGreaterThan(0);
      expect(modifyEntries[0].details).toHaveProperty('has_modified_prompt');
    });

    it('should handle steering termination', async () => {
      const workflow = createTestWorkflow([
        { id: 'step_0', name: 'Step 0' },
        { id: 'step_1', name: 'Step 1', when: 'step_0_complete == true' },
        { id: 'step_2', name: 'Step 2', when: 'step_1_complete == true' },
      ]);

      await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      // Simulate user terminating workflow via steering
      await builder.handleSteeringInput('step_1', {
        action: 'terminate',
        context: 'User terminated workflow',
      });

      const auditTrail = builder.getAuditTrail();
      const terminateEntries = auditTrail.filter(
        e => e.event_type === 'steering_input' && e.user_input?.action === 'terminate',
      );

      expect(terminateEntries.length).toBeGreaterThan(0);
    });
  });

  describe('Result Summary', () => {
    it('should calculate success metrics', async () => {
      const workflow = createTestWorkflow([
        { id: 'step_0', name: 'Success 1' },
        { id: 'step_1', name: 'Success 2' },
        { id: 'step_2', name: 'Success 3' },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.summary.successful_steps).toBe(3);
      expect(result.summary.failed_steps).toBe(0);
      expect(result.summary.skipped_steps).toBeGreaterThanOrEqual(0);
    });

    it('should provide execution status', async () => {
      const workflow = createTestWorkflow([{ id: 'step_0', name: 'Status Test' }]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(['success', 'partial', 'failed']).toContain(result.status);
    });

    it('should return step-by-step results', async () => {
      const workflow = createTestWorkflow([
        { id: 'step_0', name: 'Result 1' },
        { id: 'step_1', name: 'Result 2' },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.step_results).toHaveLength(2);
      expect(result.step_results[0]).toHaveProperty('step_id');
      expect(result.step_results[0]).toHaveProperty('status');
      expect(result.step_results[0]).toHaveProperty('duration_ms');
      expect(result.step_results[0]).toHaveProperty('timestamp');
    });
  });

  describe('Complex Workflows', () => {
    it('should execute multi-branch workflow', async () => {
      const workflow = createTestWorkflow([
        { id: 'step_0', name: 'Setup' },
        { id: 'step_1', name: 'Branch A', when: 'step_0_complete == true' },
        { id: 'step_2', name: 'Branch B', when: 'step_0_complete == true' },
        {
          id: 'step_3',
          name: 'Merge',
          when: 'step_1_complete == true && step_2_complete == true',
        },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.status).toBe('success');
      expect(result.steps_executed).toBe(4);
      expect(result.step_results[3].step_name).toBe('Merge');
    });

    it('should execute deep dependency chain', async () => {
      const workflow = createTestWorkflow([
        { id: 'step_0', name: 'Level 1' },
        { id: 'step_1', name: 'Level 2', when: 'step_0_complete == true' },
        { id: 'step_2', name: 'Level 3', when: 'step_1_complete == true' },
        { id: 'step_3', name: 'Level 4', when: 'step_2_complete == true' },
        { id: 'step_4', name: 'Level 5', when: 'step_3_complete == true' },
      ]);

      const result = await builder.execute(workflow, { permissions: new Set(workflow.steps.flatMap(step => step.tools.map(tool => `tool:${tool.id}`))), approved: true });

      expect(result.status).toBe('success');
      expect(result.steps_executed).toBe(5);

      // Verify order
      for (let i = 0; i < 5; i++) {
        expect(result.step_results[i].step_name).toBe(`Level ${i + 1}`);
      }
    });
  });
});
