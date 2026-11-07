import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@temporalio/activity';
import { z } from 'zod';
import { BuilderAgent } from '../../agents/builder.js';
import type { Workflow } from '../../parsers/plan-converter.js';
import { BuilderWorkflowSchema } from '../../schemas/builder-workflow.schema.js';
import { loadRuntime } from '../../tools/runtime.js';

export interface ActivityTrace {
  phase: 'started' | 'completed' | 'cancelled';
  workflowId: string;
  runId: string;
  activityId: string;
  attempt: number;
  workspace: string;
}

/** Trusted worker configuration, never supplied by model output or Workflow input. */
export interface BuilderActivityConfiguration {
  workspaceRoot: string;
  runtimeFactory?: (workspace: string) => ReturnType<typeof loadRuntime>;
  observe?: (event: ActivityTrace) => Promise<void>;
}

export function createBuilderExecutionActivity(config: BuilderActivityConfiguration) {
  return async function executeBuilderWorkflowActivity(workflow: Workflow, options: unknown) {
    BuilderWorkflowSchema.parse(workflow);
    const settings = z.object({ autoApprove: z.boolean().optional(),
      permissionScope: z.array(z.string()).optional() }).passthrough().parse(options);
    const context = Context.current();
    if (!context.info.workflowExecution) throw new Error('A Workflow Activity context is required');
    const { workflowId, runId } = context.info.workflowExecution;
    const key = createHash('sha256').update(`${context.info.workflowNamespace}/${workflowId}/${runId}`).digest('hex');
    const workspace = join(config.workspaceRoot, key);
    const trace = (phase: ActivityTrace['phase']): ActivityTrace => ({ phase, workflowId, runId,
      activityId: context.info.activityId, attempt: context.info.attempt, workspace });
    const beat = () => context.heartbeat({ phase: 'builder', activityId: context.info.activityId });
    beat();
    const interval = setInterval(beat, 250);
    let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
    try {
      await mkdir(workspace, { recursive: true });
      context.cancellationSignal.throwIfAborted();
      runtime = await (config.runtimeFactory ? config.runtimeFactory(workspace)
        : loadRuntime(workspace, process.env.ARC_RUNTIME_CONFIG, join(config.workspaceRoot, '.write-journal', key)));
      await config.observe?.(trace('started'));
      const permissions = settings.permissionScope
        ? new Set(settings.permissionScope.filter(permission => runtime?.permissions.has(permission)))
        : runtime.permissions;
      const result = await new BuilderAgent(runtime.registry).execute(workflow, {
        permissions, approved: settings.autoApprove === true, signal: context.cancellationSignal,
        executionId: `${workflowId}/${runId}/${context.info.activityId}`,
      });
      context.cancellationSignal.throwIfAborted();
      await config.observe?.(trace('completed'));
      context.cancellationSignal.throwIfAborted();
      return result;
    } catch (error) {
      if (context.cancellationSignal.aborted) {
        await config.observe?.(trace('cancelled'));
        throw context.cancellationSignal.reason;
      }
      throw error;
    } finally {
      clearInterval(interval);
      await runtime?.close();
    }
  };
}
