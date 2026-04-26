import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeSelectionLimit,
	evaluateReviewFilePath,
	ingestGitHubReviewFiles,
	parseGitHubUrl,
	scoreReviewFilePath,
} from "../src/github/github";

describe("parseGitHubUrl", () => {
	it("parses repo url", () => {
		const result = parseGitHubUrl("https://github.com/cloudflare/workers-sdk");
		assert.equal(result.owner, "cloudflare");
		assert.equal(result.repo, "workers-sdk");
		assert.equal(result.prNumber, undefined);
	});

	it("parses pull request url", () => {
		const result = parseGitHubUrl("https://github.com/cloudflare/workers-sdk/pull/123");
		assert.equal(result.owner, "cloudflare");
		assert.equal(result.repo, "workers-sdk");
		assert.equal(result.prNumber, 123);
	});
});

describe("evaluateReviewFilePath", () => {
	it("includes TypeScript sources", () => {
		assert.equal(evaluateReviewFilePath("src/index.ts").include, true);
	});

	it("excludes lockfiles and build output", () => {
		assert.equal(evaluateReviewFilePath("package-lock.json").include, false);
		assert.equal(evaluateReviewFilePath("dist/main.js").include, false);
	});

	it("includes docs as low priority", () => {
		assert.equal(evaluateReviewFilePath("docs/architecture.md").include, true);
	});

	it("includes common Worker project files outside TypeScript-only paths", () => {
		assert.equal(evaluateReviewFilePath("src/index.js").include, true);
		assert.equal(evaluateReviewFilePath("tsconfig.json").include, true);
		assert.equal(evaluateReviewFilePath(".github/workflows/deploy.yml").include, true);
	});
});

describe("scoreReviewFilePath", () => {
	it("gives high score to API and applies boost cap", () => {
		const score = scoreReviewFilePath("src/api/auth-handler.ts");
		assert.equal(score.baseScore, 3);
		assert.equal(score.boost, 1);
		assert.equal(score.score, 4);
	});

	it("boosts non-standard but relevant names", () => {
		const score = scoreReviewFilePath("core/server-model.ts");
		assert.equal(score.baseScore, 0);
		assert.equal(score.score, 1);
	});

	it("scores JavaScript API routes as high signal", () => {
		const score = scoreReviewFilePath("src/api/deploy.js");
		assert.equal(score.baseScore, 3);
		assert.equal(score.score, 4);
	});
});

describe("computeSelectionLimit", () => {
	it("uses dynamic bounded N", () => {
		assert.equal(computeSelectionLimit(4), 10);
		assert.equal(computeSelectionLimit(256), 16);
		assert.equal(computeSelectionLimit(2500), 25);
	});
});

describe("ingestGitHubReviewFiles", () => {
	const originalFetch = globalThis.fetch;

	it("keeps high-signal deploy files inside the deterministic top-N cap", async () => {
		const contents = new Map<string, string>([
			[
				"package.json",
				'{"name":"sample-worker","private":true,"scripts":{"dev":"wrangler dev","deploy":"wrangler deploy"}}',
			],
			[
				"wrangler.jsonc",
				'{"name":"sample-worker","main":"src/index.js","compatibility_date":"2026-04-25","observability":{"enabled":true}}',
			],
			[
				"tsconfig.json",
				'{"compilerOptions":{"strict":true,"target":"es2024","moduleResolution":"node"}}',
			],
			["src/index.js", 'export default { fetch() { return new Response("ok"); } };'],
			[
				"src/api/deploy.ts",
				'export async function deploy(request, env) { const payload = await request.json(); console.log("deploy", payload); return fetch(env.DEPLOY_HOOK_URL, { method: "POST", body: JSON.stringify(payload) }); }',
			],
			[".github/workflows/deploy.yml", "name: deploy\non: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest"],
		]);
		for (let i = 0; i < 30; i += 1) {
			contents.set(`src/utils/noise-${i}.ts`, `export const value${i} = ${i};`);
		}

		globalThis.fetch = async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.pathname === "/repos/demo/repo") {
				return Response.json({
					full_name: "demo/repo",
					private: false,
					default_branch: "main",
				});
			}
			if (url.pathname === "/repos/demo/repo/git/trees/main") {
				return Response.json({
					tree: Array.from(contents.entries()).map(([path, content]) => ({
						path,
						type: "blob",
						size: content.length,
					})),
				});
			}
			const contentPrefix = "/repos/demo/repo/contents/";
			if (url.pathname.startsWith(contentPrefix)) {
				const path = decodeURIComponent(url.pathname.slice(contentPrefix.length));
				const content = contents.get(path);
				assert.ok(content, `unexpected content fetch for ${path}`);
				return Response.json({
					type: "file",
					encoding: "base64",
					content: Buffer.from(content).toString("base64"),
					size: content.length,
				});
			}
			return new Response("not found", { status: 404 });
		};

		try {
			const result = await ingestGitHubReviewFiles({
				repoUrl: "https://github.com/demo/repo",
			});
			const selectedPaths = result.files.map((file) => file.path);
			assert.deepEqual(selectedPaths.slice(0, 6), [
				"package.json",
				"wrangler.jsonc",
				"tsconfig.json",
				"src/index.js",
				"src/api/deploy.ts",
				".github/workflows/deploy.yml",
			]);
			assert.ok(selectedPaths.length <= computeSelectionLimit(contents.size));
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
