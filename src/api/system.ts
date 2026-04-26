import pkg from "../../package.json";

function json(data: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(data), {
		headers: { "content-type": "application/json; charset=utf-8" },
		...init,
	});
}

export function handleHealth(): Response {
	return json({
		ok: true,
		service: "shipcheck-ai",
		version: pkg.version,
		features: {
			durableObjects: true,
			workersAI: true,
			workflows: true,
			githubIngestion: true,
			chat: true,
		},
	});
}
