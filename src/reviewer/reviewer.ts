import {
	buildCategoryReviewPrompt,
	DEPLOYMENT_REVIEW_SYSTEM_PROMPT,
	REVIEW_CATEGORIES,
	REVIEW_MODEL,
} from "./prompts";
import type {
	CategoryReviewResult,
	Finding,
	ReviewFile,
	ReviewCategory,
	ReviewIngestionMetadata,
	ReviewVerdict,
	ShipReadinessReport,
} from "../types";

export interface InitialReviewInput {
	repoUrl: string;
	prNumber?: number;
	files: ReviewFile[];
}
const CATEGORIES: ReviewCategory[] = [...REVIEW_CATEGORIES];

const REVIEW_VERDICTS: ReviewVerdict[] = [
	"pass",
	"needs_attention",
	"blocker",
	"unknown",
];

function normalizeVerdict(value: unknown): ReviewVerdict {
	return REVIEW_VERDICTS.includes(value as ReviewVerdict)
		? (value as ReviewVerdict)
		: "unknown";
}

function normalizeCategory(value: unknown): ReviewCategory {
	return CATEGORIES.includes(value as ReviewCategory)
		? (value as ReviewCategory)
		: "reliability";
}

function ensureStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
}

function toSafeFinding(input: unknown): Finding | null {
	if (!input || typeof input !== "object") {
		return null;
	}
	const raw = input as Record<string, unknown>;
	if (typeof raw.title !== "string" || typeof raw.summary !== "string") {
		return null;
	}
	const confidence =
		raw.confidence === "low" || raw.confidence === "medium" || raw.confidence === "high"
			? raw.confidence
			: "low";
	return {
		category: normalizeCategory(raw.category),
		verdict: normalizeVerdict(raw.verdict),
		title: raw.title,
		summary: raw.summary,
		filePaths: ensureStringArray(raw.filePaths),
		confidence,
	};
}

function fallbackReport(error: string): ShipReadinessReport & { error: string } {
	return {
		overallVerdict: "unknown",
		executiveSummary: "Unable to complete AI review.",
		findings: [],
		unknowns: ["AI output could not be parsed or validated."],
		recommendedNextSteps: [
			"Retry analysis with clearer repository context.",
			"Manually review reliability, security, performance, testing, observability, and rollback readiness.",
		],
		model: REVIEW_MODEL,
		error,
	};
}

export function parseModelResponse(rawText: string): ShipReadinessReport {
	const parsed = JSON.parse(rawText) as Record<string, unknown>;
	const findings = Array.isArray(parsed.findings)
		? parsed.findings
				.map((item) => toSafeFinding(item))
				.filter((item): item is Finding => item !== null)
		: [];

	return {
		overallVerdict: normalizeVerdict(parsed.overallVerdict),
		executiveSummary:
			typeof parsed.executiveSummary === "string"
				? parsed.executiveSummary
				: "Review completed with partial model output.",
		findings,
		unknowns: ensureStringArray(parsed.unknowns),
		recommendedNextSteps: ensureStringArray(parsed.recommendedNextSteps),
		model: REVIEW_MODEL,
	};
}

export function parseModelResponseOrFallback(
	rawText: string,
	fallbackError = "Workers AI response was not valid JSON.",
): ShipReadinessReport & { error?: string } {
	try {
		return parseModelResponse(rawText);
	} catch {
		return fallbackReport(fallbackError);
	}
}

export async function runInitialReview(
	env: Env,
	input: InitialReviewInput,
): Promise<ShipReadinessReport & { error?: string }> {
	const filesPayload = input.files.map((file) => ({
		path: file.path,
		content: file.content.slice(0, 20_000),
	}));

	const userPrompt = JSON.stringify(
		{
			repoUrl: input.repoUrl,
			prNumber: input.prNumber,
			files: filesPayload,
			instructions:
				"Evaluate deployment readiness using the required categories and return strict JSON only.",
		},
		null,
		2,
	);

	try {
		const response = await env.AI.run(REVIEW_MODEL, {
			messages: [
				{ role: "system", content: DEPLOYMENT_REVIEW_SYSTEM_PROMPT },
				{ role: "user", content: userPrompt },
			],
		});

		const text =
			typeof response === "object" &&
			response !== null &&
			"response" in response &&
			typeof response.response === "string"
				? response.response
				: "";

		if (!text) {
			return fallbackReport("Workers AI returned an empty response field.");
		}

		return parseModelResponseOrFallback(text);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Workers AI invocation failed.";
		return fallbackReport(message);
	}
}

export function filterImportantFiles(files: ReviewFile[]): ReviewFile[] {
	const importantPattern =
		/(^|\/)(package\.json|package-lock\.json|wrangler\.jsonc|tsconfig\.json|README\.md|Dockerfile|\.github\/workflows\/|src\/|worker-configuration\.d\.ts)/i;
	return files.filter((file) => importantPattern.test(file.path));
}

export function chunkFiles(files: ReviewFile[], maxChars = 40_000): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const file of files) {
		const section = `\n### ${file.path}\n${file.content}\n`;
		if (current.length > 0 && current.length + section.length > maxChars) {
			chunks.push(current);
			current = section;
		} else {
			current += section;
		}
	}
	if (current) {
		chunks.push(current);
	}
	return chunks;
}

function parseCategoryResponse(
	category: ReviewCategory,
	rawText: string,
): CategoryReviewResult {
	const parsed = JSON.parse(rawText) as Record<string, unknown>;
	const findings = Array.isArray(parsed.findings)
		? parsed.findings
				.map((item) => toSafeFinding(item))
				.filter((item): item is Finding => item !== null)
		: [];
	return {
		category,
		verdict: normalizeVerdict(parsed.verdict),
		summary:
			typeof parsed.summary === "string"
				? parsed.summary
				: `No summary returned for ${category}.`,
		findings,
		unknowns: ensureStringArray(parsed.unknowns),
	};
}

export async function runCategoryReview(
	env: Env,
	input: {
		repoUrl: string;
		prNumber?: number;
		category: ReviewCategory;
		chunks: string[];
	},
): Promise<CategoryReviewResult> {
	const userPrompt = JSON.stringify(
		{
			repoUrl: input.repoUrl,
			prNumber: input.prNumber,
			category: input.category,
			fileChunks: input.chunks,
		},
		null,
		2,
	);

	try {
		const response = await env.AI.run(REVIEW_MODEL, {
			messages: [
				{ role: "system", content: buildCategoryReviewPrompt(input.category) },
				{ role: "user", content: userPrompt },
			],
		});
		const text =
			typeof response === "object" &&
			response !== null &&
			"response" in response &&
			typeof response.response === "string"
				? response.response
				: "";
		if (!text) {
			return {
				category: input.category,
				verdict: "unknown",
				summary: "Workers AI returned an empty response.",
				findings: [],
				unknowns: ["Model did not return text output."],
				error: "Workers AI returned an empty response field.",
			};
		}
		return parseCategoryResponse(input.category, text);
	} catch (error) {
		return {
			category: input.category,
			verdict: "unknown",
			summary: "Category review failed.",
			findings: [],
			unknowns: ["Workflow should retry this step or inspect Worker logs."],
			error: error instanceof Error ? error.message : "Workers AI invocation failed.",
		};
	}
}

export async function runReviewByCategory(
	env: Env,
	input: { repoUrl: string; prNumber?: number; chunks: string[] },
): Promise<CategoryReviewResult[]> {
	const reports: CategoryReviewResult[] = [];
	for (const category of CATEGORIES) {
		const categoryReport = await runCategoryReview(env, {
			repoUrl: input.repoUrl,
			prNumber: input.prNumber,
			category,
			chunks: input.chunks,
		});
		reports.push(categoryReport);
	}
	return reports;
}

export function mergeCategoryReports(
	reports: CategoryReviewResult[],
	ingestion?: ReviewIngestionMetadata,
): ShipReadinessReport {
	const findings = reports.flatMap((report) => report.findings);
	const unknowns = reports.flatMap((report) => report.unknowns);

	const overallVerdict: ReviewVerdict = reports.some((r) => r.verdict === "blocker")
		? "blocker"
		: reports.some((r) => r.verdict === "needs_attention")
			? "needs_attention"
			: reports.every((r) => r.verdict === "pass")
				? "pass"
				: "unknown";

	const executiveSummary = reports
		.map((r) => `${r.category}: ${r.summary}`)
		.join(" ");

	return {
		overallVerdict,
		executiveSummary,
		findings,
		unknowns,
		recommendedNextSteps: [
			"Address blocker and needs_attention findings before deploying.",
			"Add or improve tests for changed deployment paths.",
			"Validate rollback procedure in a staging environment.",
		],
		model: REVIEW_MODEL,
		ingestion,
	};
}
