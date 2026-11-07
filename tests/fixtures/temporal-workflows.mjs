import { proxyActivities, ActivityCancellationType } from '@temporalio/workflow';
export { executeWorkflowDurable, executeTraditionalWorkflow } from '../../dist/src/temporal/workflows/execute-workflow.js';

/** Deliberately unsafe retry policy, only present in this isolated verification bundle. */
export async function unsafeRetryDemonstration(options) {
  const { executeBuilderWorkflowActivity } = proxyActivities({
    activityId: 'unsafe-retry-demonstration', startToCloseTimeout: 10000, heartbeatTimeout: 1500,
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 2, initialInterval: 200, maximumInterval: 200 },
  });
  return executeBuilderWorkflowActivity(options.preparedWorkflow, { autoApprove: true });
}
