/** Lifecycle of a review run inside a Durable Object session. */
export type ReviewStatus = "idle" | "analyzing" | "done";

export type ReviewCategory =
	| "reliability"
	| "security"
	| "performance"
	| "testing"
	| "observability"
	| "rollback_readiness";

export type ReviewVerdict = "pass" | "needs_attention" | "blocker" | "unknown";
export type ReviewConfidence = "low" | "medium" | "high";
export type ReviewEffort = "low" | "medium" | "high";
export type ChatRole = "user" | "assistant" | "system";

export interface Finding {
	category: ReviewCategory;
	verdict: ReviewVerdict;
	title: string;
	summary: string;
	filePaths: string[];
	confidence: ReviewConfidence;
}

export interface ShipReadinessReport {
	overallVerdict: ReviewVerdict;
	executiveSummary: string;
	findings: Finding[];
	unknowns: string[];
	recommendedNextSteps: string[];
	fixPlan?: FixPlan;
	model: string;
	ingestion?: ReviewIngestionMetadata;
}

export interface FixStep {
	step: number;
	title: string;
	category: ReviewCategory;
	why: string;
	files: string[];
	action: string;
	riskReduction: ReviewEffort;
}

export interface FixPlan {
	priorityOrder: FixStep[];
	estimatedEffort: ReviewEffort;
	blocksDeployment: boolean;
}

export interface ReviewFile {
	path: string;
	content: string;
}

export interface SkippedFile {
	path: string;
	reason: string;
}

export type ReviewSource = "manual" | "github";

export interface ReviewIngestionMetadata {
	source: ReviewSource;
	totalFilesCount?: number;
	selectedFileCount: number;
	skippedFileCount: number;
	skippedFiles: SkippedFile[];
	selectionStrategy?: "ranked-top-N-v2";
	guarantees?: {
		packageJsonIncluded: boolean;
		wranglerConfigIncluded: boolean;
		entryFileIncluded: boolean;
		apiOrRouteIncluded: boolean;
	};
	countsByPriority?: {
		high: number;
		medium: number;
		low: number;
	};
}

export interface CategoryReviewResult {
	category: ReviewCategory;
	verdict: ReviewVerdict;
	summary: string;
	findings: Finding[];
	unknowns: string[];
	error?: string;
}

export interface DeploymentReviewWorkflowParams {
	sessionId: string;
	files: ReviewFile[];
	source: ReviewSource;
	githubToken?: string;
	skippedFiles?: SkippedFile[];
	ingestionMetadata?: ReviewIngestionMetadata;
}

export interface ChatMessage {
	role: ChatRole;
	content: string;
	createdAt: string;
	relatedCategory?: ReviewCategory;
}

/** Persisted review context for one repo-scoped session (see `src/index.ts` routing). */
export interface ReviewSessionState {
	sessionId: string;
	repoUrl: string;
	prNumber?: number;
	status: ReviewStatus;
	report?: ShipReadinessReport;
	chat: ChatMessage[];
	error?: string;
	/** Epoch ms — basic metadata for clients and debugging. */
	updatedAt: number;
}
