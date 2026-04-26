import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { DeploymentReviewWorkflowParams } from "../types";
import {
	chunkFiles,
	filterImportantFiles,
	mergeCategoryReports,
	runReviewByCategory,
} from "../reviewer/reviewer";
import { generateFixPlan } from "../reviewer/fixPlan";

/**
 * Durable review pipeline using Cloudflare Workflows.
 * Each step is persisted and retried independently by the Workflows runtime.
 */
export class DeploymentReviewWorkflow extends WorkflowEntrypoint<
	Env,
	DeploymentReviewWorkflowParams
> {
	private async persistFailure(sessionId: string, message: string): Promise<void> {
		const stub = this.env.REVIEW_AGENT.getByName(sessionId);
		await stub.completeReview({ error: message });
	}

	async run(
		event: Readonly<WorkflowEvent<DeploymentReviewWorkflowParams>>,
		step: WorkflowStep,
	): Promise<{ sessionId: string; status: "done" }> {
		const { sessionId } = event.payload;

		try {
			const session = await step.do(
				"load session state",
				{ retries: { limit: 2, delay: "2 seconds", backoff: "exponential" } },
				async () => {
					const stub = this.env.REVIEW_AGENT.getByName(sessionId);
					const state = await stub.getReviewState();
					if (!state) {
						throw new NonRetryableError("Review session not found.");
					}
					await stub.markAnalyzing();
					return { repoUrl: state.repoUrl, prNumber: state.prNumber };
				},
			);

			const files = await step.do("accept files payload", async () => {
				const incoming = event.payload.files;
				if (!Array.isArray(incoming) || incoming.length === 0) {
					throw new NonRetryableError("No files provided for analysis.");
				}
				return incoming;
			});

			const importantFiles = await step.do(
				"filter important files",
				async () => {
					const filtered = filterImportantFiles(files);
					return filtered.length > 0 ? filtered : files;
				},
			);

			const fileChunks = await step.do("chunk files", async () => {
				const chunks = chunkFiles(importantFiles);
				if (chunks.length === 0) {
					throw new NonRetryableError("No chunkable file content found.");
				}
				return chunks;
			});

			const categoryReports = await step.do(
				"run workers ai review by category",
				{ retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
				async () =>
					runReviewByCategory(this.env, {
						repoUrl: session.repoUrl,
						prNumber: session.prNumber,
						chunks: fileChunks,
					}),
			);

			const mergedReport = await step.do("merge category reports", async () =>
				mergeCategoryReports(categoryReports, {
					source: event.payload.source,
					totalFilesCount: event.payload.ingestionMetadata?.totalFilesCount,
					selectedFileCount:
						event.payload.ingestionMetadata?.selectedFileCount ?? files.length,
					skippedFileCount:
						event.payload.ingestionMetadata?.skippedFileCount ??
						event.payload.skippedFiles?.length ??
						0,
					skippedFiles:
						event.payload.ingestionMetadata?.skippedFiles ??
						event.payload.skippedFiles ??
						[],
					selectionStrategy: event.payload.ingestionMetadata?.selectionStrategy,
					guarantees: event.payload.ingestionMetadata?.guarantees,
					countsByPriority: event.payload.ingestionMetadata?.countsByPriority,
				}),
			);

			const reportWithFixPlan = await step.do(
				"generate fix plan",
				{ retries: { limit: 2, delay: "3 seconds", backoff: "exponential" } },
				async () => {
					const fixPlan = await generateFixPlan(this.env, mergedReport);
					return {
						...mergedReport,
						fixPlan,
					};
				},
			);

			await step.do("store final report in review agent", async () => {
				const stub = this.env.REVIEW_AGENT.getByName(sessionId);
				await stub.completeReview({ report: reportWithFixPlan });
				return { ok: true };
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Workflow execution failed.";
			await this.persistFailure(sessionId, message);
			throw error;
		}

		return { sessionId, status: "done" };
	}
}
