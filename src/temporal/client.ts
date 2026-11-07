/**
 * Temporal Client
 * 
 * Starts and manages workflow executions.
 */

import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { executeWorkflowDurable, executeTraditionalWorkflow } from './workflows/execute-workflow.js';
import type { WorkflowExecutionOptions, WorkflowExecutionResult } from './workflows/execute-workflow.js';

export class TemporalClient {
    private client: Client | null = null;
    private connection: Connection | null = null;
    constructor(private readonly configuration: { address?: string; namespace?: string; taskQueue?: string } = {}) {}

    async connect(): Promise<void> {
        if (this.client) return;

        try {
            this.connection = await Connection.connect({
                address: this.configuration.address ?? process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233'
            });

            this.client = new Client({
                connection: this.connection,
                namespace: this.configuration.namespace ?? process.env.TEMPORAL_NAMESPACE ?? 'default'
            });

            console.log('✅ Connected to Temporal server');
        } catch (error) {
            console.error('❌ Failed to connect to Temporal:', error);
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        if (this.connection) {
            await this.connection.close();
            this.connection = null;
            this.client = null;
        }
    }

    /**
     * Start a durable workflow execution
     */
    async startWorkflow(
        options: WorkflowExecutionOptions
    ): Promise<WorkflowExecutionResult> {
        await this.connect();

        if (!this.client) {
            throw new Error('Temporal client not connected');
        }

        try {
            const workflowId = options.workflowId ?? `workflow-${randomUUID()}`;

            console.log(`🚀 Starting workflow: ${workflowId}`);
            console.log(`📝 Request: ${options.request}`);

            const handle = await this.client.workflow.start(executeWorkflowDurable, {
                args: [options],
                taskQueue: this.configuration.taskQueue ?? process.env.TEMPORAL_TASK_QUEUE ?? 'arc-workflows',
                workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowIdConflictPolicy: 'FAIL',
                workflowId,
                workflowExecutionTimeout: options.timeout ? `${options.timeout}ms` : '30m'
            });

            console.log(`⏳ Workflow started, waiting for result...`);

            const result = await handle.result();

            console.log(`✅ Workflow completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);
            console.log(`📊 Stats: ${result.stats.successfulSteps}/${result.stats.totalSteps} steps succeeded`);
            console.log(`⏱️  Duration: ${result.executionTime}ms`);

            return result;
        } catch (error) {
            console.error('❌ Workflow execution failed:', error);
            throw error;
        }
    }

    /**
     * Start a traditional workflow from YAML file
     */
    async startTraditionalWorkflow(
        workflowPath: string,
        options: any
    ): Promise<WorkflowExecutionResult> {
        await this.connect();

        if (!this.client) {
            throw new Error('Temporal client not connected');
        }

        try {
            const workflowId = `traditional-${randomUUID()}`;

            console.log(`🚀 Starting traditional workflow: ${workflowId}`);
            console.log(`📄 File: ${workflowPath}`);

            const handle = await this.client.workflow.start(executeTraditionalWorkflow, {
                args: [workflowPath, options],
                taskQueue: this.configuration.taskQueue ?? process.env.TEMPORAL_TASK_QUEUE ?? 'arc-workflows',
                workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowIdConflictPolicy: 'FAIL',
                workflowId,
                workflowExecutionTimeout: '30m'
            });

            const result = await handle.result();

            console.log(`✅ Workflow completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);

            return result;
        } catch (error) {
            console.error('❌ Workflow execution failed:', error);
            throw error;
        }
    }

    /**
     * Query workflow status
     */
    async getWorkflowStatus(workflowId: string): Promise<any> {
        await this.connect();

        if (!this.client) {
            throw new Error('Temporal client not connected');
        }

        try {
            const handle = this.client.workflow.getHandle(workflowId);
            const description = await handle.describe();

            return {
                workflowId,
                status: description.status.name,
                startTime: description.startTime,
                closeTime: description.closeTime,
                executionTime: description.closeTime && description.startTime
                    ? description.closeTime.getTime() - description.startTime.getTime()
                    : null
            };
        } catch (error) {
            console.error('Failed to get workflow status:', error);
            return null;
        }
    }

    /**
     * Cancel a running workflow
     */
    async cancelWorkflow(workflowId: string): Promise<void> {
        await this.connect();

        if (!this.client) {
            throw new Error('Temporal client not connected');
        }

        try {
            const handle = this.client.workflow.getHandle(workflowId);
            await handle.cancel();
            console.log(`🛑 Workflow ${workflowId} cancelled`);
        } catch (error) {
            console.error('Failed to cancel workflow:', error);
            throw error;
        }
    }
}

// Singleton instance
let temporalClient: TemporalClient | null = null;

export function getTemporalClient(): TemporalClient {
    if (!temporalClient) {
        temporalClient = new TemporalClient();
    }
    return temporalClient;
}
