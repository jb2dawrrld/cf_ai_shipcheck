import type { ChatMessage, ReviewCategory, ShipReadinessReport } from "../types";

const CHAT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const MAX_HISTORY = 12;
const MAX_CHAT_MESSAGE_LENGTH = 2000;

function buildSystemPrompt(): string {
	return `You are ShipCheck AI remediation assistant.

You must be concise, practical, and grounded in the provided ship-readiness report.
Rules:
1) Do not claim you inspected repository files beyond what appears in the report/findings.
2) Reference categories and file paths from findings when available.
3) Prioritize risk reduction and deploy safety.
4) If evidence is missing, say what is unknown and suggest validation steps.
5) If a fix plan is provided, use it as the primary remediation sequence and explain tradeoffs for shortcuts.
6) Keep answer actionable (bullets are fine).
7) Output plain text only.`;
}

function pickRelatedCategory(
	report: ShipReadinessReport,
	message: string,
): ReviewCategory | undefined {
	const lower = message.toLowerCase();
	const categories: ReviewCategory[] = [
		"reliability",
		"security",
		"performance",
		"testing",
		"observability",
		"rollback_readiness",
	];
	for (const category of categories) {
		if (lower.includes(category.replace("_", " "))) return category;
	}
	for (const finding of report.findings) {
		if (lower.includes(finding.category.replace("_", " "))) return finding.category;
	}
	return undefined;
}

export async function runRemediationChat(
	env: Env,
	input: {
		report: ShipReadinessReport;
		chatHistory: ChatMessage[];
		userMessage: string;
	},
): Promise<{ assistantMessage: ChatMessage; relatedCategory?: ReviewCategory }> {
	const recentHistory = input.chatHistory.slice(-MAX_HISTORY).map((m) => ({
		role: m.role,
		content: m.content,
	}));
	const relatedCategory = pickRelatedCategory(input.report, input.userMessage);

	const promptPayload = JSON.stringify(
		{
			report: input.report,
			fixPlan: input.report.fixPlan ?? null,
			userMessage: input.userMessage,
			relatedCategory,
		},
		null,
		2,
	);

	const response = await env.AI.run(CHAT_MODEL, {
		messages: [
			{ role: "system", content: buildSystemPrompt() },
			...recentHistory,
			{ role: "user", content: promptPayload },
		],
	});

	const text =
		typeof response === "object" &&
		response !== null &&
		"response" in response &&
		typeof response.response === "string"
			? response.response.trim()
			: "";

	if (!text) {
		throw new Error("Chat model returned empty output.");
	}

	return {
		assistantMessage: {
			role: "assistant",
			content: text,
			createdAt: new Date().toISOString(),
			relatedCategory,
		},
		relatedCategory,
	};
}

export function validateChatMessageInput(message: unknown): {
	ok: boolean;
	error?: string;
	value?: string;
} {
	if (typeof message !== "string") {
		return { ok: false, error: "message is required" };
	}
	const trimmed = message.trim();
	if (!trimmed) {
		return { ok: false, error: "message is required" };
	}
	if (trimmed.length > MAX_CHAT_MESSAGE_LENGTH) {
		return { ok: false, error: `message exceeds ${MAX_CHAT_MESSAGE_LENGTH} characters` };
	}
	return { ok: true, value: trimmed };
}
