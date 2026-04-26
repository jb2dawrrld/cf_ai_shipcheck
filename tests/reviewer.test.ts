import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_REVIEW_FILES } from "../src/demo/sampleFiles";
import {
	chunkFiles,
	filterImportantFiles,
	mergeCategoryReports,
	parseModelResponseOrFallback,
} from "../src/reviewer/reviewer";

describe("parseModelResponseOrFallback", () => {
	it("returns fallback with error for invalid JSON", () => {
		const result = parseModelResponseOrFallback("not json");
		assert.equal(result.overallVerdict, "unknown");
		assert.equal(typeof result.error, "string");
	});

	it("parses valid model JSON response", () => {
		const result = parseModelResponseOrFallback(
			JSON.stringify({
				overallVerdict: "pass",
				executiveSummary: "Looks good.",
				findings: [],
				unknowns: [],
				recommendedNextSteps: [],
			}),
		);
		assert.equal(result.overallVerdict, "pass");
		assert.equal(result.executiveSummary, "Looks good.");
	});
});

describe("demo review scenario", () => {
	it("passes the sample deploy validation issue into analysis chunks", () => {
		const importantFiles = filterImportantFiles(DEMO_REVIEW_FILES);
		const chunks = chunkFiles(importantFiles);
		const payload = chunks.join("\n");

		assert.match(payload, /src\/api\/deploy\.ts/);
		assert.match(payload, /request\.json\(\)/);
		assert.match(payload, /deploy\.example\.internal/);
	});

	it("surfaces category findings in the merged analysis report", () => {
		const report = mergeCategoryReports([
			{
				category: "reliability",
				verdict: "needs_attention",
				summary: "Deploy endpoint accepts unvalidated payloads.",
				findings: [
					{
						category: "reliability",
						verdict: "needs_attention",
						title: "Deployment payload is not validated",
						summary:
							"src/api/deploy.ts forwards request JSON to the deployment hook without validating required fields.",
						filePaths: ["src/api/deploy.ts"],
						confidence: "high",
					},
				],
				unknowns: [],
			},
		]);

		assert.equal(report.overallVerdict, "needs_attention");
		assert.equal(report.findings[0]?.filePaths[0], "src/api/deploy.ts");
		assert.match(report.executiveSummary, /unvalidated payloads/);
	});
});
