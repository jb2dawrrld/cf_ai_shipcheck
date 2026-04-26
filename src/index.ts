import {
	handleAnalyzeReview,
	handleGetReview,
	handleReviewChat,
	handleStartReview,
} from "./api/reviews";
import { handleHealth } from "./api/system";
import { handleDemoReview } from "./api/demo";
export { ReviewAgent } from "./agent/ReviewAgent";
export { DeploymentReviewWorkflow } from "./workflow/DeploymentReviewWorkflow";

/**
 * ShipCheck AI Worker — HTTP entrypoint.
 *
 * Durable Object routing (review sessions):
 * - Each **repository** maps to one Durable Object id via `repoUrlToSessionId` (stable SHA-256 hex).
 * - `env.REVIEW_AGENT.getByName(sessionId)` yields a **stub** that forwards
 *   RPC calls (`startReview`, `getReviewState`) to the colocated `ReviewAgent` instance.
 * - The same `sessionId` string is returned to clients so `GET /api/reviews/:id` can reach the correct DO
 *   without a separate registry service.
 */
export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const url = new URL(request.url);

		// Static assets (e.g. public/index.html) are handled by Wrangler assets; only API routes need logic here.
		if (url.pathname === "/api/reviews/start" && request.method === "POST") {
			return handleStartReview(request, env);
		}
		if (url.pathname === "/api/health" && request.method === "GET") {
			return handleHealth();
		}
		if (url.pathname === "/api/demo/review" && request.method === "POST") {
			return handleDemoReview(env);
		}

		const reviewMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)$/);
		if (reviewMatch && request.method === "GET") {
			return handleGetReview(reviewMatch[1], env);
		}

		const analyzeMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/analyze$/);
		if (analyzeMatch && request.method === "POST") {
			return handleAnalyzeReview(analyzeMatch[1], request, env);
		}

		const chatMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/chat$/);
		if (chatMatch && request.method === "POST") {
			return handleReviewChat(chatMatch[1], request, env);
		}

		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
