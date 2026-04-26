import type { ReviewFile } from "../types";

/**
 * Demo-only fixture payload that mirrors files in `fixtures/sample-files/`.
 * Keep these in sync when updating demo content.
 */
export const DEMO_REVIEW_FILES: ReviewFile[] = [
	{
		path: "package.json",
		content: `{
  "name": "shipcheck-sample",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  }
}`,
	},
	{
		path: "wrangler.jsonc",
		content: `{
  "name": "shipcheck-sample",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-25",
  "observability": { "enabled": true }
}`,
	},
	{
		path: "src/index.ts",
		content: `export default {
  async fetch(): Promise<Response> {
    return new Response("hello");
  },
} satisfies ExportedHandler<Env>;`,
	},
	{
		path: "src/api/deploy.ts",
		content: `type DeployRequest = {
  environment?: string;
  ref?: string;
};

export async function deploy(request: Request, env: Env): Promise<Response> {
  const payload = (await request.json()) as DeployRequest;
  console.log("starting deployment", payload);

  await fetch("https://deploy.example.internal/hook", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return Response.json({ queued: true });
}`,
	},
	{
		path: "README.md",
		content: `# ShipCheck Sample

Demo project used to validate ShipCheck AI workflow and dashboard flow.`,
	},
];
