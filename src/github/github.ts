import type { ReviewIngestionMetadata, ReviewFile, SkippedFile } from "../types";

const GITHUB_API_BASE = "https://api.github.com";
const MAX_FILE_SIZE_BYTES = 250_000;
const MAX_FILE_CONTENT_CHARS = 40_000;
const TRIVIAL_CONTENT_MIN_CHARS = 40;

export interface ParsedGitHubUrl {
	owner: string;
	repo: string;
	prNumber?: number;
}

export interface GitHubRepoMetadata {
	fullName: string;
	private: boolean;
	defaultBranch: string;
	description?: string | null;
}

export interface GitHubTreeEntry {
	path: string;
	type: "blob" | "tree";
	size?: number;
}

export interface GitHubPullRequestFile {
	path: string;
	status: string;
}

export interface GitHubIngestionResult {
	files: ReviewFile[];
	skippedFiles: SkippedFile[];
	metadata: ReviewIngestionMetadata;
}

type PriorityTier = "high" | "medium" | "low";

interface FileScore {
	baseScore: number;
	boost: number;
	score: number;
	specificity: number;
	tier?: PriorityTier;
}

export class GitHubError extends Error {
	constructor(
		message: string,
		public readonly code:
			| "INVALID_GITHUB_URL"
			| "REPO_NOT_FOUND"
			| "PRIVATE_REPO_TOKEN_REQUIRED"
			| "RATE_LIMIT"
			| "PR_NOT_FOUND"
			| "GITHUB_API_ERROR"
			| "NO_REVIEWABLE_FILES",
		public readonly status = 400,
	) {
		super(message);
		this.name = "GitHubError";
	}
}

export function parseGitHubUrl(input: string): ParsedGitHubUrl {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new GitHubError("Invalid GitHub URL.", "INVALID_GITHUB_URL", 400);
	}

	if (parsed.hostname.toLowerCase() !== "github.com") {
		throw new GitHubError("Invalid GitHub URL.", "INVALID_GITHUB_URL", 400);
	}

	const parts = parsed.pathname.split("/").filter(Boolean);
	if (parts.length < 2) {
		throw new GitHubError("Invalid GitHub URL.", "INVALID_GITHUB_URL", 400);
	}

	const owner = parts[0];
	const repo = parts[1].replace(/\.git$/i, "");
	let prNumber: number | undefined;
	if (parts.length >= 4 && parts[2] === "pull") {
		const n = Number(parts[3]);
		if (!Number.isInteger(n) || n < 1) {
			throw new GitHubError("Invalid PR number in GitHub URL.", "INVALID_GITHUB_URL", 400);
		}
		prNumber = n;
	}

	return { owner, repo, prNumber };
}

function truncateText(content: string): string {
	if (content.length <= MAX_FILE_CONTENT_CHARS) {
		return content;
	}
	return `${content.slice(0, MAX_FILE_CONTENT_CHARS)}\n/* truncated for safety */`;
}

function isLockFile(path: string): boolean {
	return /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i.test(path);
}

function isExcludedPath(path: string): boolean {
	return /(^|\/)(node_modules|dist|build|\.next)(\/|$)/i.test(path);
}

function isBinaryOrImage(path: string): boolean {
	return /\.(png|jpg|jpeg|gif|webp|svg|ico|pdf|zip|gz|tar|woff2?|ttf|eot|mp3|mp4|mov|wasm|exe|dll|bin)$/i.test(path);
}

function isHugeGenerated(path: string): boolean {
	return /\.(min\.(js|css)|map)$/i.test(path) || /generated/i.test(path);
}

function isReviewCandidate(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	return (
		/(^|\/)package\.json$/i.test(normalized) ||
		/(^|\/)tsconfig\.json$/i.test(normalized) ||
		normalized.toLowerCase() === "readme.md" ||
		/(^|\/)wrangler\.(toml|jsonc)$/i.test(normalized) ||
		/^\.github\/workflows\/.+\.ya?ml$/i.test(normalized) ||
		/(^|\/)src\/.*\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(normalized) ||
		/(^|\/)app\/.*\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(normalized) ||
		/(^|\/)pages\/.*\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(normalized) ||
		/(^|\/).*(worker|workers?)\.(ts|tsx|js|mjs)$/i.test(normalized) ||
		/(^|\/)worker\//i.test(normalized)
	);
}

const SIGNAL_BOOST_TERMS = [
	"auth",
	"api",
	"route",
	"handler",
	"server",
	"middleware",
	"config",
	"client",
	"db",
	"model",
];

const HIGH_PRIORITY_PATTERNS: Array<{
	regex: RegExp;
	specificity: number;
}> = [
	{ regex: /^package\.json$/i, specificity: 120 },
	{ regex: /^wrangler\.(jsonc|toml)$/i, specificity: 120 },
	{ regex: /^tsconfig\.json$/i, specificity: 105 },
	{ regex: /^src\/index\.(ts|tsx|js|jsx|mjs|cjs)$/i, specificity: 110 },
	{ regex: /^src\/api\/.+/i, specificity: 100 },
	{ regex: /^src\/routes\/.+/i, specificity: 100 },
	{ regex: /^worker\.(ts|tsx|js|jsx|mjs|cjs)$/i, specificity: 100 },
	{ regex: /^src\/worker\.(ts|tsx|js|jsx|mjs|cjs)$/i, specificity: 100 },
	{ regex: /^workers\/.+\/index\.(ts|tsx|js|jsx|mjs|cjs)$/i, specificity: 95 },
	{ regex: /(^|\/)src\/index\.(ts|tsx|js|jsx|mjs|cjs)$/i, specificity: 88 },
	{ regex: /(^|\/)src\/(api|routes)\/.+/i, specificity: 86 },
];

const MEDIUM_PRIORITY_PATTERNS: Array<{
	regex: RegExp;
	specificity: number;
}> = [
	{ regex: /^src\/services\/.+/i, specificity: 80 },
	{ regex: /^src\/lib\/.+/i, specificity: 80 },
	{ regex: /^src\/utils\/.+/i, specificity: 80 },
	{ regex: /(^|\/)wrangler\.(jsonc|toml)$/i, specificity: 78 },
	{ regex: /(^|\/)src\/.+/i, specificity: 75 },
	{ regex: /(^|\/)(app|pages)\/.+/i, specificity: 72 },
	{ regex: /(^|\/)(package|tsconfig)\.json$/i, specificity: 70 },
];

const LOW_PRIORITY_PATTERNS: Array<{
	regex: RegExp;
	specificity: number;
}> = [
	{ regex: /^readme\.md$/i, specificity: 50 },
	{ regex: /^\.github\/workflows\/.+\.ya?ml$/i, specificity: 50 },
	{ regex: /^docs\/.+/i, specificity: 50 },
	{ regex: /^tests?\/.+/i, specificity: 45 },
	{ regex: /(^|\/).+\.(test|spec)\.[a-z0-9]+$/i, specificity: 45 },
];

function getPriorityMatch(path: string): {
	baseScore: number;
	tier?: PriorityTier;
	specificity: number;
} {
	const normalized = path.replace(/\\/g, "/");
	for (const p of HIGH_PRIORITY_PATTERNS) {
		if (p.regex.test(normalized)) {
			return { baseScore: 3, tier: "high", specificity: p.specificity };
		}
	}
	for (const p of MEDIUM_PRIORITY_PATTERNS) {
		if (p.regex.test(normalized)) {
			return { baseScore: 2, tier: "medium", specificity: p.specificity };
		}
	}
	for (const p of LOW_PRIORITY_PATTERNS) {
		if (p.regex.test(normalized)) {
			return { baseScore: 1, tier: "low", specificity: p.specificity };
		}
	}
	return { baseScore: 0, specificity: 0 };
}

export function scoreReviewFilePath(path: string): FileScore {
	const normalized = path.toLowerCase();
	const priority = getPriorityMatch(path);
	const boost = SIGNAL_BOOST_TERMS.some((term) => normalized.includes(term)) ? 1 : 0;
	const score = Math.min(4, priority.baseScore + boost);
	return {
		baseScore: priority.baseScore,
		boost,
		score,
		specificity: priority.specificity,
		tier: priority.tier,
	};
}

export function computeSelectionLimit(totalFilesCount: number): number {
	const safeTotal = Math.max(1, totalFilesCount);
	return Math.min(25, Math.max(10, Math.floor(Math.sqrt(safeTotal))));
}

function isEntryFile(path: string): boolean {
	return (
		/^src\/index\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path) ||
		/^worker\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path) ||
		/^src\/worker\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path) ||
		/^workers\/.+\/index\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path) ||
		/(^|\/)src\/index\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path)
	);
}

function isApiRouteFile(path: string): boolean {
	return /(^|\/)src\/(api|routes)\/.+/i.test(path);
}

function isWranglerConfig(path: string): boolean {
	return /(^|\/)wrangler\.(jsonc|toml)$/i.test(path);
}

function isProjectConfig(path: string): boolean {
	return /(^|\/)tsconfig\.json$/i.test(path);
}

function isWorkflowConfig(path: string): boolean {
	return /^\.github\/workflows\/.+\.ya?ml$/i.test(path);
}

function isTrivialContent(content: string): boolean {
	const nonWhitespace = content.replace(/\s+/g, "");
	return nonWhitespace.length < TRIVIAL_CONTENT_MIN_CHARS;
}

type RankedCandidate = {
	path: string;
	size?: number;
	score: FileScore;
};

function rankCandidates(candidates: RankedCandidate[]): RankedCandidate[] {
	return [...candidates].sort((a, b) => {
		if (b.score.score !== a.score.score) return b.score.score - a.score.score;
		if (b.score.specificity !== a.score.specificity) {
			return b.score.specificity - a.score.specificity;
		}
		const aSize = typeof a.size === "number" ? a.size : Number.MAX_SAFE_INTEGER;
		const bSize = typeof b.size === "number" ? b.size : Number.MAX_SAFE_INTEGER;
		if (aSize !== bSize) return aSize - bSize;
		return a.path.localeCompare(b.path);
	});
}

export function evaluateReviewFilePath(path: string): {
	include: boolean;
	reason?: string;
} {
	if (isExcludedPath(path)) return { include: false, reason: "excluded directory" };
	if (isLockFile(path)) return { include: false, reason: "lock file excluded" };
	if (isBinaryOrImage(path)) return { include: false, reason: "binary/image file excluded" };
	if (isHugeGenerated(path)) return { include: false, reason: "generated/minified file excluded" };
	const score = scoreReviewFilePath(path);
	if (!isReviewCandidate(path) && score.score <= 0) {
		return { include: false, reason: "not in review include set" };
	}
	return { include: true };
}

async function githubFetch(
	path: string,
	githubToken?: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Accept", "application/vnd.github+json");
	headers.set("User-Agent", "shipcheck-ai");
	if (githubToken) {
		headers.set("Authorization", `Bearer ${githubToken}`);
	}
	const response = await fetch(`${GITHUB_API_BASE}${path}`, { ...init, headers });

	if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
		throw new GitHubError("GitHub API rate limit exceeded.", "RATE_LIMIT", 429);
	}

	return response;
}

function handleGitHubResponseError(response: Response, fallback: string): never {
	if (response.status === 404) {
		throw new GitHubError("Repository not found.", "REPO_NOT_FOUND", 404);
	}
	if (response.status === 401 || response.status === 403) {
		throw new GitHubError("Private repo or unauthorized access. Provide a valid token.", "PRIVATE_REPO_TOKEN_REQUIRED", 401);
	}
	throw new GitHubError(fallback, "GITHUB_API_ERROR", response.status);
}

export async function fetchRepoMetadata(
	owner: string,
	repo: string,
	githubToken?: string,
): Promise<GitHubRepoMetadata> {
	const response = await githubFetch(`/repos/${owner}/${repo}`, githubToken);
	if (!response.ok) {
		handleGitHubResponseError(response, "Failed to fetch repository metadata.");
	}
	const data = (await response.json()) as {
		full_name: string;
		private: boolean;
		default_branch: string;
		description?: string | null;
	};
	return {
		fullName: data.full_name,
		private: data.private,
		defaultBranch: data.default_branch,
		description: data.description,
	};
}

export async function fetchDefaultBranch(
	owner: string,
	repo: string,
	githubToken?: string,
): Promise<string> {
	const metadata = await fetchRepoMetadata(owner, repo, githubToken);
	return metadata.defaultBranch;
}

export async function fetchRepoTree(
	owner: string,
	repo: string,
	branch: string,
	githubToken?: string,
): Promise<GitHubTreeEntry[]> {
	const response = await githubFetch(
		`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
		githubToken,
	);
	if (!response.ok) {
		handleGitHubResponseError(response, "Failed to fetch repository tree.");
	}
	const data = (await response.json()) as {
		tree: Array<{ path: string; type: "blob" | "tree"; size?: number }>;
	};
	return data.tree.map((item) => ({ path: item.path, type: item.type, size: item.size }));
}

export async function fetchFileContent(
	owner: string,
	repo: string,
	path: string,
	ref: string,
	githubToken?: string,
): Promise<{ content: string; truncated: boolean }> {
	const encodedPath = path.split("/").map(encodeURIComponent).join("/");
	const response = await githubFetch(
		`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
		githubToken,
	);
	if (!response.ok) {
		handleGitHubResponseError(response, `Failed to fetch file content for ${path}.`);
	}
	const data = (await response.json()) as {
		type: string;
		encoding?: string;
		content?: string;
		size?: number;
	};

	if (data.type !== "file") {
		throw new GitHubError(`Unsupported content type for ${path}.`, "GITHUB_API_ERROR", 400);
	}
	if ((data.size ?? 0) > MAX_FILE_SIZE_BYTES) {
		throw new GitHubError(`File too large: ${path}.`, "GITHUB_API_ERROR", 400);
	}
	if (data.encoding !== "base64" || typeof data.content !== "string") {
		throw new GitHubError(`Unsupported encoding for ${path}.`, "GITHUB_API_ERROR", 400);
	}

	const decoded = atob(data.content.replace(/\n/g, ""));
	const text = truncateText(decoded);
	return { content: text, truncated: text.length !== decoded.length };
}

export async function fetchPullRequestFiles(
	owner: string,
	repo: string,
	prNumber: number,
	githubToken?: string,
): Promise<GitHubPullRequestFile[]> {
	const results: GitHubPullRequestFile[] = [];
	let page = 1;
	while (true) {
		const response = await githubFetch(
			`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
			githubToken,
		);
		if (response.status === 404) {
			throw new GitHubError("Pull request not found.", "PR_NOT_FOUND", 404);
		}
		if (!response.ok) {
			handleGitHubResponseError(response, "Failed to fetch pull request files.");
		}
		const files = (await response.json()) as Array<{ filename: string; status: string }>;
		if (files.length === 0) break;
		for (const file of files) {
			results.push({ path: file.filename, status: file.status });
		}
		if (files.length < 100) break;
		page += 1;
	}
	return results;
}

async function resolveRefForPullRequest(
	owner: string,
	repo: string,
	prNumber: number,
	githubToken?: string,
): Promise<string> {
	const response = await githubFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, githubToken);
	if (response.status === 404) {
		throw new GitHubError("Pull request not found.", "PR_NOT_FOUND", 404);
	}
	if (!response.ok) {
		handleGitHubResponseError(response, "Failed to fetch pull request metadata.");
	}
	const data = (await response.json()) as { head: { sha: string } };
	return data.head.sha;
}

export async function ingestGitHubReviewFiles(input: {
	repoUrl: string;
	prNumber?: number;
	githubToken?: string;
}): Promise<GitHubIngestionResult> {
	const { owner, repo, prNumber: urlPr } = parseGitHubUrl(input.repoUrl);
	const prNumber = input.prNumber ?? urlPr;

	const defaultBranch = await fetchDefaultBranch(owner, repo, input.githubToken);
	const ref = prNumber
		? await resolveRefForPullRequest(owner, repo, prNumber, input.githubToken)
		: defaultBranch;

	const candidateByPath = new Map<string, RankedCandidate>();
	const skippedFiles: SkippedFile[] = [];
	let totalFilesCount = 0;

	if (prNumber) {
		const prFiles = await fetchPullRequestFiles(owner, repo, prNumber, input.githubToken);
		for (const file of prFiles) {
			totalFilesCount += 1;
			const decision = evaluateReviewFilePath(file.path);
			if (decision.include) {
				candidateByPath.set(file.path, {
					path: file.path,
					score: scoreReviewFilePath(file.path),
				});
			} else {
				skippedFiles.push({ path: file.path, reason: decision.reason ?? "filtered out" });
			}
		}
	} else {
		const tree = await fetchRepoTree(owner, repo, defaultBranch, input.githubToken);
		for (const entry of tree) {
			if (entry.type !== "blob") continue;
			totalFilesCount += 1;
			const decision = evaluateReviewFilePath(entry.path);
			if (!decision.include) {
				skippedFiles.push({ path: entry.path, reason: decision.reason ?? "filtered out" });
				continue;
			}
			if (typeof entry.size === "number" && entry.size > MAX_FILE_SIZE_BYTES) {
				skippedFiles.push({ path: entry.path, reason: "file exceeds safe size limit" });
				continue;
			}
			candidateByPath.set(entry.path, {
				path: entry.path,
				size: entry.size,
				score: scoreReviewFilePath(entry.path),
			});
		}
	}

	const ranked = rankCandidates(Array.from(candidateByPath.values()));
	const selectionLimit = computeSelectionLimit(totalFilesCount);
	const selectedPathSet = new Set<string>();
	const selectedQueue: RankedCandidate[] = [];
	const pushCandidate = (candidate: RankedCandidate | undefined): void => {
		if (!candidate || selectedPathSet.has(candidate.path)) return;
		selectedPathSet.add(candidate.path);
		selectedQueue.push(candidate);
	};

	pushCandidate(ranked.find((c) => /^package\.json$/i.test(c.path)));
	pushCandidate(ranked.find((c) => isWranglerConfig(c.path)));
	pushCandidate(ranked.find((c) => isProjectConfig(c.path)));
	pushCandidate(ranked.find((c) => isEntryFile(c.path)));
	pushCandidate(ranked.find((c) => isApiRouteFile(c.path)));
	pushCandidate(ranked.find((c) => isWorkflowConfig(c.path)));
	for (const candidate of ranked) {
		if (selectedQueue.length >= selectionLimit) break;
		pushCandidate(candidate);
	}

	const files: ReviewFile[] = [];
	const selectedPriorities: PriorityTier[] = [];
	for (const candidate of selectedQueue) {
		const path = candidate.path;
		try {
			const { content, truncated } = await fetchFileContent(
				owner,
				repo,
				path,
				ref,
				input.githubToken,
			);
			if (!content.trim()) {
				skippedFiles.push({ path, reason: "empty file content" });
				continue;
			}
			if (isTrivialContent(content)) {
				skippedFiles.push({ path, reason: "trivial file content" });
				continue;
			}
			files.push({ path, content });
			if (candidate.score.tier) {
				selectedPriorities.push(candidate.score.tier);
			}
			if (truncated) {
				skippedFiles.push({ path, reason: "content truncated to safe limit" });
			}
		} catch (error) {
			if (error instanceof GitHubError && error.message.includes("File too large")) {
				skippedFiles.push({ path, reason: "file exceeds safe size limit" });
				continue;
			}
			if (error instanceof GitHubError && error.code === "GITHUB_API_ERROR") {
				skippedFiles.push({ path, reason: "unable to fetch file content" });
				continue;
			}
			throw error;
		}
	}

	if (files.length === 0) {
		throw new GitHubError("No reviewable files found.", "NO_REVIEWABLE_FILES", 400);
	}

	const selectedPaths = new Set(files.map((f) => f.path));
	const metadata: ReviewIngestionMetadata = {
		source: "github",
		totalFilesCount,
		selectedFileCount: files.length,
		skippedFileCount: skippedFiles.length,
		skippedFiles,
		selectionStrategy: "ranked-top-N-v2",
		guarantees: {
			packageJsonIncluded: selectedPaths.has("package.json"),
			wranglerConfigIncluded: Array.from(selectedPaths).some((p) => isWranglerConfig(p)),
			entryFileIncluded: Array.from(selectedPaths).some((p) => isEntryFile(p)),
			apiOrRouteIncluded: Array.from(selectedPaths).some((p) => isApiRouteFile(p)),
		},
		countsByPriority: {
			high: selectedPriorities.filter((p) => p === "high").length,
			medium: selectedPriorities.filter((p) => p === "medium").length,
			low: selectedPriorities.filter((p) => p === "low").length,
		},
	};

	return { files, skippedFiles, metadata };
}
