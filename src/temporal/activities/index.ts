/**
 * Temporal Activities
 * 
 * Activities are the building blocks of workflows.
 * They can be non-deterministic and interact with external services.
 */

import { KnowledgeBase, assembleRetrievedContext, type QueryResult } from '../../rag/knowledge-base.js';
import { ClaudeScraper } from '../../scraping/claude-scraper.js';
import { ArchitectService } from '../../services/architect-service.js';
import { PlanConverter } from '../../parsers/plan-converter.js';
import { Context } from '@temporalio/activity';
import { loadRuntime } from '../../tools/runtime.js';
import { z } from 'zod';
import { BuilderAgent } from '../../agents/builder.js';
import type { WorkflowStep } from '../../parsers/plan-converter.js';
import { createBuilderExecutionActivity } from './builder-activity.js';
import { resolve } from 'node:path';


// Initialize services
let knowledgeBase: Promise<KnowledgeBase> | undefined;
let scraper: ClaudeScraper | null = null;
let runtime: ReturnType<typeof loadRuntime> | undefined;
const getRuntime = () => runtime ??= loadRuntime(process.cwd(), process.env.ARC_RUNTIME_CONFIG);

async function getKnowledgeBase(): Promise<KnowledgeBase> {
    return knowledgeBase ??= (async () => {
        const instance = new KnowledgeBase();
        await instance.connect();
        return instance;
    })().catch(error => { knowledgeBase = undefined; throw error; });
}

function getScraper(): ClaudeScraper {
    if (!scraper) {
        scraper = new ClaudeScraper();
    }
    return scraper;
}

/**
 * Query RAG knowledge base for relevant context
 */
export async function queryRAGActivity(request: string): Promise<any> {
    try {
        const kb = await getKnowledgeBase();
        const context = await kb.queryContext(request, {
            limit: 5,
            threshold: 0.7
        });

        // Analyze context to determine if external docs are needed
        const needsExternalDocs = context.length < 2 ||
            context.every(c => c.similarity < 0.8);

        // Extract potential documentation URLs from request
        const urlMatch = request.match(/https?:\/\/[^\s]+/);
        const documentationUrl = urlMatch ? urlMatch[0] : null;

        // Extract topic from request
        const topicMatch = request.match(/\b(express|react|node|typescript|python|api|rest|graphql)\b/i);
        const topic = topicMatch ? topicMatch[0] : 'general';

        return {
            similarWorkflows: context,
            needsExternalDocs,
            documentationUrl,
            topic,
            confidence: context.length > 0 ? context[0].similarity : 0
        };
    } catch (error) {
        console.error('RAG query failed:', error);
        return {
            similarWorkflows: [],
            needsExternalDocs: false,
            confidence: 0
        };
    }
}

/**
 * Scrape documentation from a URL
 */
export async function scrapeDocumentationActivity(
    url: string,
    topic: string
): Promise<any> {
    try {
        const webScraper = getScraper();
        const docs = await webScraper.scrapeDocumentation(url, topic);

        // Store in knowledge base for future use
        const kb = await getKnowledgeBase();
        await kb.addWebScrapedDocs(url, topic, JSON.stringify(docs));

        return docs;
    } catch (error) {
        console.error('Documentation scraping failed:', error);
        return null;
    }
}

/**
 * Generate plan using Architect agent with context
 */
export async function generatePlanActivity(
    request: string,
    context: { similarWorkflows?: QueryResult[] } | null
): Promise<any> {
    try {
        const current = await getRuntime();
        const references = assembleRetrievedContext(context?.similarWorkflows ?? []);
        const plan = await new ArchitectService({}, current.registry.catalog()).createPlanFromRequest(request, Context.current().cancellationSignal, references);
        if ('error_code' in plan) throw new Error(plan.error_message);
        const conversion = await new PlanConverter(current.registry.catalog()).convert(plan);
        return conversion.workflow;

    } catch (error) {
        console.error('Plan generation failed:', error);
        throw error;
    }
}

/**
 * Execute a single workflow step
 */
export async function executeStepActivity(
    step: WorkflowStep | { type: 'workflow-file'; path: string },
    options: unknown
): Promise<any> {
    try {
        if ('type' in step) {
            const { loadWorkflowFromFile } = await import('../../parsers/workflow-parser.js');
            const { executeWorkflow } = await import('../../engine/workflow-engine.js');
            const report = await executeWorkflow(await loadWorkflowFromFile(step.path));
            if (!report.success) throw new Error(report.errors.join('; '));
            return report;
        }
        const current = await getRuntime();
        const executionOptions = z.object({ autoApprove: z.boolean().optional() }).passthrough().parse(options);
        const builderAgent = new BuilderAgent(current.registry);

        const execution = await builderAgent.execute({
            name: `Temporal step ${step.id}`, steps: [step],
            metadata: { architect_plan_id: 'temporal', confidence_score: 1,
                conversion_timestamp: new Date().toISOString(), tool_count: 1, hallucination_count: 0 },
        }, { permissions: current.permissions, approved: executionOptions.autoApprove === true, signal: Context.current().cancellationSignal });
        const result = execution.step_results[0];
        if (!result || result.status !== 'success') throw new Error(result?.error?.message || 'Tool execution failed');

        return result;
    } catch (error) {
        console.error('Step execution failed:', error);
        throw error;
    }
}

/** One activity preserves dependency state; non-idempotent execution is not automatically retried. */
export const executeBuilderWorkflowActivity = createBuilderExecutionActivity({
    workspaceRoot: resolve(process.env.ARC_TEMPORAL_WORKSPACE_ROOT || '.arc/temporal-runs'),
});

/**
 * Store workflow results in knowledge base
 */
export async function storeResultsActivity(data: {
    request: string;
    plan: any;
    results: any[];
    context: any;
    success: boolean;
}): Promise<void> {
    try {
        const kb = await getKnowledgeBase();

        // Store workflow execution
        await kb.addWorkflow(
            data.request,
            {
                success: data.success,
                stats: {
                    totalSteps: data.plan.steps?.length || 0,
                    successfulSteps: data.results.filter((r: any) => r.status === 'success').length,
                    failedSteps: data.results.filter((r: any) => r.status === 'failed').length
                },
                errors: data.results.filter((r: any) => r.status === 'failed'),
                executionTime: data.results.reduce((sum: number, r: any) => sum + (r.duration || 0), 0)
            },
            JSON.stringify(data.context)
        );

        // Store error resolutions if any
        for (const result of data.results) {
            if (result.status === 'failed' && result.resolution) {
                await kb.addErrorResolution(
                    result.error,
                    result.resolution,
                    data.request
                );
            }
        }
    } catch (error) {
        console.error('Result storage failed:', error);
        throw error;
    }
}

/**
 * Search Stack Overflow for error solutions
 */
export async function searchStackOverflowActivity(
    errorMessage: string
): Promise<any> {
    try {
        const webScraper = getScraper();
        const solutions = await webScraper.searchStackOverflow(errorMessage);

        // Store solutions in knowledge base
        if (solutions.length > 0) {
            const kb = await getKnowledgeBase();
            for (const solution of solutions) {
                await kb.addErrorResolution(
                    errorMessage,
                    solution.answer,
                    `Stack Overflow: ${solution.link}`
                );
            }
        }

        return solutions;
    } catch (error) {
        console.error('Stack Overflow search failed:', error);
        return [];
    }
}

/**
 * Get package information from npm
 */
export async function getPackageInfoActivity(
    packageName: string
): Promise<any> {
    try {
        const webScraper = getScraper();
        return await webScraper.getPackageInfo(packageName);
    } catch (error) {
        console.error('Package info retrieval failed:', error);
        return null;
    }
}

/**
 * Cleanup function to close connections
 */
export async function cleanup(): Promise<void> {
    if (runtime) { await (await runtime).close(); runtime = undefined; }
    if (knowledgeBase) {
        await (await knowledgeBase).disconnect();
        knowledgeBase = undefined;
    }
    if (scraper) {
        scraper.clearCache();
        scraper = null;
    }
}
