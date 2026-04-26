/**
 * Stable identifier for a repository, used as:
 * - the Durable Object `idFromName` key (one DO instance per logical repo)
 * - the `sessionId` returned to API clients for GET /api/reviews/:id
 */
export function normalizeRepoUrl(repoUrl: string): string {
	const trimmed = repoUrl.trim();
	if (!trimmed) {
		throw new Error("repoUrl is empty");
	}
	try {
		const u = new URL(trimmed);
		const path = u.pathname.replace(/\/+$/, "") || "";
		return `${u.protocol}//${u.host}${path}`.toLowerCase();
	} catch {
		return trimmed.toLowerCase().replace(/\/+$/, "");
	}
}

export async function repoUrlToSessionId(repoUrl: string): Promise<string> {
	const normalized = normalizeRepoUrl(repoUrl);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(normalized),
	);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
