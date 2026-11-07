/**
 * Temporal Workflow for Durable Workflow Execution
 * 
 * Provides fault-tolerant, long-running workflow execution with automatic retries.
 */

import { proxyActivities, ActivityCancellationType, isCancellation, CancellationScope, CancelledFailure } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { Workflow } from '../../parsers/plan-converter.js';

function rethrowCancellation(error: unknown): void {
    if (isCancellation(error)) throw error;
    // A crashed activity can time out while its cancellation acknowledgement is pending.
    // The root workflow cancellation still takes precedence over an ordinary timeout result.
    if (CancellationScope.current().consideredCancelled) throw new CancelledFailure('Workflow cancellation requested');
}

// Configure activity timeouts and retries
const {
    generatePlanActivity,
    queryRAGActivity,
    storeResultsActivity,
    scrapeDocumentationActivity
} = proxyActivities<typeof activities>({
    startToCloseTimeout: '10 minutes',
    retry: {
        // These activities may call models or persist data; require an explicit idempotent contract before retrying.
        maximumAttempts: 1
    }
});

const { executeStepActivity } = proxyActivities<typeof activities>({
    startToCloseTimeout: '10 minutes', cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 1 },
});

export interface WorkflowExecutionOptions {
    request: string;
    workflowId?: string;
    timeout?: number;
    retries?: number;
    autoApprove?: boolean;
    noSteering?: boolean;
    enableRAG?: boolean;
    enableWebScraping?: boolean;
    preparedWorkflow?: Workflow;
    persistResults?: boolean;
    permissionScope?: string[];
    activityTimeoutMs?: number;
    heartbeatTimeoutMs?: number;
}

export interface WorkflowExecutionResult {
    success: boolean;
    plan: any;
    results: any[];
    context?: any;
    errors: any[];
    executionTime: number;
    stats: {
        totalSteps: number;
        successfulSteps: number;
        failedSteps: number;
    };
}

/**
 * Main durable workflow execution
 * 
 * This workflow is deterministic and can survive crashes/restarts.
 * All non-deterministic operations are delegated to activities.
 */
export async function executeWorkflowDurable(
    options: WorkflowExecutionOptions
): Promise<WorkflowExecutionResult> {
    const startTime = Date.now();
    const errors: any[] = [];
    let context: any = null;
    let plan: any = null;
    const results: any[] = [];

    try {
        // Step 1: Query RAG for context (if enabled)
        if (!options.preparedWorkflow && options.enableRAG !== false) {
            try {
                context = await queryRAGActivity(options.request);
            } catch (error) {
        rethrowCancellation(error);
                errors.push({
                    step: 'rag-query',
                    message: `RAG query failed: ${error}`,
                    recoverable: true
                });
                // Continue without context
            }
        }

        // Step 2: Scrape documentation if needed (if enabled)
        if (!options.preparedWorkflow && options.enableWebScraping && context?.needsExternalDocs) {
            try {
                const scrapedDocs = await scrapeDocumentationActivity(
                    context.documentationUrl,
                    context.topic
                );
                context.externalDocs = scrapedDocs;
            } catch (error) {
        rethrowCancellation(error);
                errors.push({
                    step: 'web-scraping',
                    message: `Web scraping failed: ${error}`,
                    recoverable: true
                });
                // Continue without external docs
            }
        }

        // Step 3: Generate plan with context
        try {
            plan = options.preparedWorkflow ?? await generatePlanActivity(options.request, context);
        } catch (error) {
        rethrowCancellation(error);
            errors.push({
                step: 'planning',
                message: `Plan generation failed: ${error}`,
                recoverable: false
            });
            throw error; // Cannot continue without a plan
        }

        // Preserve dependency state inside the Builder activity. Never retry non-idempotent tools automatically.
        const { executeBuilderWorkflowActivity } = proxyActivities<typeof activities>({
            activityId: 'execute-builder',
            startToCloseTimeout: options.activityTimeoutMs ?? 600000,
            heartbeatTimeout: options.heartbeatTimeoutMs ?? 10000,
            cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
            retry: { maximumAttempts: 1 },
        });
        const execution = await executeBuilderWorkflowActivity(plan, { autoApprove: options.autoApprove,
            ...(options.permissionScope ? { permissionScope: options.permissionScope } : {}) });
        results.push(...execution.step_results.map(result => ({ ...result, duration: result.duration_ms })));
        errors.push(...execution.errors.map(error => ({ ...error, recoverable: false })));

        // Step 5: Store results for future learning
        if (options.persistResults !== false) try {
            await storeResultsActivity({
                request: options.request,
                plan,
                results,
                context,
                success: errors.filter(e => !e.recoverable).length === 0
            });
        } catch (error) {
        rethrowCancellation(error);
            errors.push({
                step: 'storage',
                message: `Result storage failed: ${error}`,
                recoverable: true
            });
            // Non-critical, continue
        }

        // Calculate stats
        const successfulSteps = results.filter(r => r.status === 'success').length;
        const failedSteps = results.filter(r => r.status === 'failed').length;

        return {
            success: errors.filter(e => !e.recoverable).length === 0 && results.every(result => result.status !== 'failed'),
            plan,
            results,
            context,
            errors,
            executionTime: Date.now() - startTime,
            stats: {
                totalSteps: plan.steps.length,
                successfulSteps,
                failedSteps
            }
        };
    } catch (error) {
        rethrowCancellation(error);
        // Workflow-level error
        return {
            success: false,
            plan: plan || { steps: [] },
            results,
            context,
            errors: [
                ...errors,
                {
                    step: 'workflow',
                    message: `Workflow failed: ${error}`,
                    recoverable: false
                }
            ],
            executionTime: Date.now() - startTime,
            stats: {
                totalSteps: plan?.steps?.length || 0,
                successfulSteps: results.filter(r => r.status === 'success').length,
                failedSteps: results.filter(r => r.status === 'failed').length
            }
        };
    }
}

/**
 * Simplified workflow for traditional YAML-based execution
 */
export async function executeTraditionalWorkflow(
    workflowPath: string,
    options: any
): Promise<WorkflowExecutionResult> {
    const startTime = Date.now();

    try {
        // Load and execute workflow (delegated to activity)
        const result = await executeStepActivity(
            { type: 'workflow-file', path: workflowPath },
            options
        );

        return {
            success: true,
            plan: { steps: [] },
            results: [result],
            errors: [],
            executionTime: Date.now() - startTime,
            stats: {
                totalSteps: 1,
                successfulSteps: 1,
                failedSteps: 0
            }
        };
    } catch (error) {
        rethrowCancellation(error);
        return {
            success: false,
            plan: { steps: [] },
            results: [],
            errors: [{
                step: 'workflow-execution',
                message: String(error),
                recoverable: false
            }],
            executionTime: Date.now() - startTime,
            stats: {
                totalSteps: 1,
                successfulSteps: 0,
                failedSteps: 1
            }
        };
    }
}
