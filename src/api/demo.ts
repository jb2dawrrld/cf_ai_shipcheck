import { repoUrlToSessionId, normalizeRepoUrl } from "../lib/repoSession";
import type { DeploymentReviewWorkflowParams } from "../types";
import { DEMO_REVIEW_FILES } from "../demo/sampleFiles";

function json(data: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(data), {
		headers: { "content-type": "application/json; charset=utf-8" },
		...init,
	});
}

/**
 * Demo-only endpoint to quickly showcase the full ShipCheck flow without
 * requiring live GitHub ingestion.
 */
export async function handleDemoReview(env: Env): Promise<Response> {
	const repoUrl = normalizeRepoUrl("https://github.com/demo/shipcheck-sample");
	const sessionId = await repoUrlToSessionId(repoUrl);
	const stub = env.REVIEW_AGENT.getByName(sessionId);

	await stub.startReview({
		sessionId,
		repoUrl,
		prNumber: undefined,
	});

	const payload: DeploymentReviewWorkflowParams = {
		sessionId,
		files: DEMO_REVIEW_FILES,
		source: "manual",
		skippedFiles: [],
	};
	const workflowInstance = await env.DEPLOYMENT_REVIEW_WORKFLOW.create({
		params: payload,
	});

	return json(
		{
			sessionId,
			workflowInstanceId: workflowInstance.id,
			status: "queued",
			demo: true,
		},
		{ status: 202 },
	);
}
