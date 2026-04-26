import { REVIEW_MODEL } from "./prompts";
import type {
	Finding,
	FixPlan,
	FixStep,
	ReviewCategory,
	ReviewEffort,
	ShipReadinessReport,
} from "../types";

const EFFORT_VALUES: ReviewEffort[] = ["low", "medium", "high"];
const CATEGORIES: ReviewCategory[] = [
	"reliability",
	"security",
	"performance",
	"testing",
	"observability",
	"rollback_readiness",
];

function asEffort(value: unknown, fallback: ReviewEffort = "medium"): ReviewEffort {
	return EFFORT_VALUES.includes(value as ReviewEffort)
		? (value as ReviewEffort)
		: fallback;
}

function asCategory(value: unknown, fallback: ReviewCategory = "reliability"): ReviewCategory {
	return CATEGORIES.includes(value as ReviewCategory)
		? (value as ReviewCategory)
		: fallback;
}

function ensureStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

function fallbackFixPlan(report: ShipReadinessReport): FixPlan {
	const riskyFindings = [...report.findings]
		.filter((f) => f.verdict !== "pass")
		.sort((a, b) => {
			const rank = { blocker: 0, needs_attention: 1, unknown: 2, pass: 3 };
			return rank[a.verdict] - rank[b.verdict];
		})
		.slice(0, 5);

	const priorityOrder: FixStep[] = riskyFindings.map((finding, index) => ({
		step: index + 1,
		title: `Address ${finding.category} risk: ${finding.title}`,
		category: finding.category,
		why: finding.summary,
		files: finding.filePaths,
		action: "Implement a targeted fix, then add or update tests and observability checks for this risk.",
		riskReduction: finding.verdict === "blocker" ? "high" : "medium",
	}));

	return {
		priorityOrder,
		estimatedEffort: priorityOrder.length >= 4 ? "high" : priorityOrder.length >= 2 ? "medium" : "low",
		blocksDeployment: report.overallVerdict === "blocker",
	};
}

function parseFixPlan(raw: string, report: ShipReadinessReport): FixPlan {
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const rawSteps = Array.isArray(parsed.priorityOrder) ? parsed.priorityOrder : [];

	const priorityOrder: FixStep[] = rawSteps
		.map((item, index) => {
			if (!item || typeof item !== "object") return null;
			const step = item as Record<string, unknown>;
			if (
				typeof step.title !== "string" ||
				typeof step.why !== "string" ||
				typeof step.action !== "string"
			) {
				return null;
			}
			return {
				step:
					typeof step.step === "number" && Number.isInteger(step.step) && step.step > 0
						? step.step
						: index + 1,
				title: step.title,
				category: asCategory(step.category),
				why: step.why,
				files: ensureStringArray(step.files),
				action: step.action,
				riskReduction: asEffort(step.riskReduction, "medium"),
			} satisfies FixStep;
		})
		.filter((s): s is FixStep => s !== null)
		.sort((a, b) => a.step - b.step);

	if (priorityOrder.length === 0) {
		return fallbackFixPlan(report);
	}

	return {
		priorityOrder,
		estimatedEffort: asEffort(parsed.estimatedEffort, "medium"),
		blocksDeployment:
			typeof parsed.blocksDeployment === "boolean"
				? parsed.blocksDeployment
				: report.overallVerdict === "blocker",
	};
}

export async function generateFixPlan(
	env: Env,
	report: ShipReadinessReport,
): Promise<FixPlan> {
	const prompt = `You are generating an ordered deployment remediation plan.

Rules:
1) Prioritize highest-risk issues first.
2) Minimize number of steps.
3) Be practical: include real code actions, not vague advice.
4) Reference file paths only when present in findings.
5) Do not hallucinate unknown files.
6) Output JSON only.

Return strict JSON:
{
  "priorityOrder": [
    {
      "step": 1,
      "title": "string",
      "category": "reliability" | "security" | "performance" | "testing" | "observability" | "rollback_readiness",
      "why": "string",
      "files": ["path/to/file"],
      "action": "string",
      "riskReduction": "low" | "medium" | "high"
    }
  ],
  "estimatedEffort": "low" | "medium" | "high",
  "blocksDeployment": boolean
}`;

	const response = await env.AI.run(REVIEW_MODEL, {
		messages: [
			{ role: "system", content: prompt },
			{
				role: "user",
				content: JSON.stringify({ report }, null, 2),
			},
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
		return fallbackFixPlan(report);
	}

	try {
		return parseFixPlan(text, report);
	} catch {
		return fallbackFixPlan(report);
	}
}

