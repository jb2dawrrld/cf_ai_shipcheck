import { repoUrlToSessionId, normalizeRepoUrl } from "../lib/repoSession";
import {
	GitHubError,
	ingestGitHubReviewFiles,
} from "../github/github";
import type {
	ChatMessage,
	DeploymentReviewWorkflowParams,
	ReviewIngestionMetadata,
	ReviewFile,
	ReviewSessionState,
	ReviewSource,
	SkippedFile,
} from "../types";
import { runRemediationChat, validateChatMessageInput } from "../chat/chat";

function json(data: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(data), {
		headers: { "content-type": "application/json; charset=utf-8" },
		...init,
	});
}

interface StartBody {
	repoUrl?: string;
	prNumber?: number;
}

interface AnalyzeBody {
	files?: Array<{ path?: string; content?: string }>;
	githubToken?: string;
}

interface ChatBody {
	message?: string;
}

export async function handleStartReview(
	request: Request,
	env: Env,
): Promise<Response> {
	let body: StartBody;
	try {
		body = (await request.json()) as StartBody;
	} catch {
		return json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const repoUrlRaw = body.repoUrl;
	if (typeof repoUrlRaw !== "string" || !repoUrlRaw.trim()) {
		return json({ error: "repoUrl is required and must be a non-empty string" }, { status: 400 });
	}

	let prNumber: number | undefined;
	if (body.prNumber !== undefined && body.prNumber !== null) {
		if (typeof body.prNumber !== "number" || !Number.isInteger(body.prNumber) || body.prNumber < 1) {
			return json({ error: "prNumber must be a positive integer when provided" }, { status: 400 });
		}
		prNumber = body.prNumber;
	}

	let normalized: string;
	try {
		normalized = normalizeRepoUrl(repoUrlRaw);
	} catch {
		return json({ error: "repoUrl is empty" }, { status: 400 });
	}

	const sessionId = await repoUrlToSessionId(repoUrlRaw);
	const stub = env.REVIEW_AGENT.getByName(sessionId);

	const state = await stub.startReview({
		sessionId,
		repoUrl: normalized,
		prNumber,
	});

	return json({ sessionId: state.sessionId });
}

export async function handleGetReview(
	sessionId: string,
	env: Env,
): Promise<Response> {
	if (!/^[0-9a-f]{64}$/.test(sessionId)) {
		return json({ error: "Invalid session id" }, { status: 400 });
	}

	const stub = env.REVIEW_AGENT.getByName(sessionId);
	const state: ReviewSessionState | null = await stub.getReviewState();

	if (!state) {
		return json({ error: "Review session not found" }, { status: 404 });
	}

	return json(state);
}

export async function handleAnalyzeReview(
	sessionId: string,
	request: Request,
	env: Env,
): Promise<Response> {
	if (!/^[0-9a-f]{64}$/.test(sessionId)) {
		return json({ error: "Invalid session id" }, { status: 400 });
	}

	let body: AnalyzeBody;
	try {
		body = (await request.json()) as AnalyzeBody;
	} catch {
		return json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const inputFiles = Array.isArray(body.files) ? body.files : [];
	const manualFiles = inputFiles
		.filter(
			(file): file is { path: string; content: string } =>
				typeof file?.path === "string" && typeof file?.content === "string",
		)
		.map((file) => ({ path: file.path, content: file.content }));

	const stub = env.REVIEW_AGENT.getByName(sessionId);
	const existing = (await stub.getReviewState()) as ReviewSessionState | null;
	if (!existing) {
		return json({ error: "Review session not found" }, { status: 404 });
	}

	let source: ReviewSource = "manual";
	let files: ReviewFile[] = manualFiles;
	let skippedFiles: SkippedFile[] = [];
	let ingestionMetadata: ReviewIngestionMetadata | undefined;

	if (files.length === 0) {
		source = "github";
		try {
			const ingestion = await ingestGitHubReviewFiles({
				repoUrl: existing.repoUrl,
				prNumber: existing.prNumber,
				githubToken:
					typeof body.githubToken === "string" && body.githubToken.trim()
						? body.githubToken.trim()
						: undefined,
			});
			files = ingestion.files;
			skippedFiles = ingestion.skippedFiles;
			ingestionMetadata = ingestion.metadata;
		} catch (error) {
			if (error instanceof GitHubError) {
				return json(
					{
						error: error.message,
						code: error.code,
					},
					{ status: error.status },
				);
			}
			return json({ error: "GitHub ingestion failed." }, { status: 502 });
		}
	}

	if (files.length === 0) {
		return json({ error: "No reviewable files found" }, { status: 400 });
	}

	const payload: DeploymentReviewWorkflowParams = {
		sessionId,
		files,
		source,
		skippedFiles,
		ingestionMetadata,
	};
	const workflowInstance = await env.DEPLOYMENT_REVIEW_WORKFLOW.create({
		params: payload,
	});

	return json(
		{
			sessionId,
			workflowInstanceId: workflowInstance.id,
			status: "queued",
		},
		{ status: 202 },
	);
}

export async function handleReviewChat(
	sessionId: string,
	request: Request,
	env: Env,
): Promise<Response> {
	if (!/^[0-9a-f]{64}$/.test(sessionId)) {
		return json({ error: "Invalid session id" }, { status: 400 });
	}

	let body: ChatBody;
	try {
		body = (await request.json()) as ChatBody;
	} catch {
		return json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const validated = validateChatMessageInput(body.message);
	if (!validated.ok || !validated.value) {
		return json({ error: validated.error ?? "message is required" }, { status: 400 });
	}
	const message = validated.value;

	const stub = env.REVIEW_AGENT.getByName(sessionId);
	const state = (await stub.getReviewState()) as ReviewSessionState | null;
	if (!state) {
		return json({ error: "Review session not found" }, { status: 404 });
	}
	if (!state.report) {
		return json({ error: "Report is required before using chat." }, { status: 400 });
	}

	const userMessage: ChatMessage = {
		role: "user",
		content: message,
		createdAt: new Date().toISOString(),
	};
	const afterUser = await stub.appendChatMessage(userMessage);
	if (!afterUser) {
		return json({ error: "Unable to update chat session." }, { status: 500 });
	}

	try {
		const chatResult = await runRemediationChat(env, {
			report: state.report,
			chatHistory: afterUser.chat ?? [],
			userMessage: message,
		});
		const afterAssistant = await stub.appendChatMessage(chatResult.assistantMessage);
		if (!afterAssistant) {
			return json({ error: "Unable to save assistant response." }, { status: 500 });
		}
		return json({
			message: chatResult.assistantMessage,
			chat: afterAssistant.chat ?? [],
		});
	} catch (error) {
		return json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to generate remediation response.",
			},
			{ status: 502 },
		);
	}
}
