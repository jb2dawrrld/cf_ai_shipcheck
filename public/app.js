/**
 * @typedef {"reliability"|"security"|"performance"|"testing"|"observability"|"rollback_readiness"} ReviewCategory
 * @typedef {"pass"|"needs_attention"|"blocker"|"unknown"} ReviewVerdict
 */

const POLL_INTERVAL_MS = 2000;
const CATEGORIES = [
	"reliability",
	"security",
	"performance",
	"testing",
	"observability",
	"rollback_readiness",
];

/** @type {number | null} */
let pollTimer = null;
let isRunning = false;
let isChatLoading = false;
let currentSessionId = "";
let hasReport = false;

const form = document.getElementById("review-form");
const repoUrlInput = document.getElementById("repo-url");
const prNumberInput = document.getElementById("pr-number");
const githubTokenInput = document.getElementById("github-token");
const startBtn = document.getElementById("start-btn");
const demoBtn = document.getElementById("demo-btn");

const statusEl = document.getElementById("status");
const sessionIdEl = document.getElementById("session-id");
const workflowIdEl = document.getElementById("workflow-id");
const reviewStatusEl = document.getElementById("review-status");
const errorEl = document.getElementById("error-message");
const resultsPanelEl = document.getElementById("results-panel");
const ingestionDetailsEl = document.getElementById("ingestion-details");

const overallScoreEl = document.getElementById("overall-score");
const overallVerdictEl = document.getElementById("overall-verdict");
const executiveSummaryEl = document.getElementById("executive-summary");
const ingestionSummaryEl = document.getElementById("ingestion-summary");
const categoryCardsEl = document.getElementById("category-cards");
const topRisksEl = document.getElementById("top-risks");
const fixPlanEl = document.getElementById("fix-plan");
const ingestionMetaEl = document.getElementById("ingestion-meta");
const skippedFilesEl = document.getElementById("skipped-files");
const fixPlanBannerEl = document.getElementById("fix-plan-banner");
const fixPlanMetaEl = document.getElementById("fix-plan-meta");
const fixPlanStepsEl = document.getElementById("fix-plan-steps");
const chatMessagesEl = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");

function setBusy(busy) {
	isRunning = busy;
	startBtn.disabled = busy;
	demoBtn.disabled = busy;
	repoUrlInput.disabled = busy;
	prNumberInput.disabled = busy;
	chatSendBtn.disabled = busy || isChatLoading || !currentSessionId || !hasReport;
}

function setChatLoading(loading) {
	isChatLoading = loading;
	chatSendBtn.disabled = loading || isRunning || !currentSessionId || !hasReport;
	chatInput.disabled = loading || !currentSessionId || !hasReport;
}

function setStatus(text) {
	statusEl.textContent = text;
}

function showError(message) {
	errorEl.textContent = message;
	errorEl.classList.remove("hidden");
}

function clearError() {
	errorEl.textContent = "";
	errorEl.classList.add("hidden");
}

function clearPolling() {
	if (pollTimer !== null) {
		window.clearInterval(pollTimer);
		pollTimer = null;
	}
}

function verdictScore(verdict) {
	switch (verdict) {
		case "pass":
			return 90;
		case "needs_attention":
			return 65;
		case "blocker":
			return 35;
		default:
			return 50;
	}
}

function normalizeExecutiveSummary(text) {
	if (!text) return "";
	let normalized = text;
	const labels = [
		"reliability",
		"security",
		"performance",
		"testing",
		"observability",
		"rollback_readiness",
		"rollback readiness",
	];
	for (const label of labels) {
		const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`(^|\\.|\\s)(${escaped})\\s*:`, "gi");
		normalized = normalized.replace(regex, (match, prefix, found) => {
			const pretty = found
				.replace("rollback_readiness", "Rollback Readiness")
				.replace("rollback readiness", "Rollback Readiness")
				.replace(/\b\w/g, (c) => c.toUpperCase());
			return `${prefix}${pretty}:`;
		});
	}
	return normalized;
}

function setBadge(el, verdict) {
	el.className = `badge ${verdict}`;
	el.textContent = verdict.replace("_", " ");
}

function categoryFindings(findings, category) {
	return findings.filter((f) => f.category === category);
}

function renderList(target, items, fallbackText) {
	target.innerHTML = "";
	if (!items || items.length === 0) {
		const li = document.createElement("li");
		li.textContent = fallbackText;
		target.appendChild(li);
		return;
	}
	for (const item of items) {
		const li = document.createElement("li");
		li.textContent = item;
		target.appendChild(li);
	}
}

function severityClass(verdict) {
	switch (verdict) {
		case "pass":
			return "pass";
		case "needs_attention":
			return "needs_attention";
		case "blocker":
			return "blocker";
		default:
			return "unknown";
	}
}

function severityIconClass(state) {
	switch (state) {
		case "No issues found":
			return "status-good";
		case "Needs attention":
			return "status-warn";
		case "Unavailable":
			return "status-unavailable";
		case "Insufficient data":
			return "status-insufficient";
		default:
			return "status-unavailable";
	}
}

function titleCaseLabel(text) {
	return String(text)
		.replace(/_/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderRiskCards(target, findings) {
	target.innerHTML = "";
	if (!findings || findings.length === 0) {
		renderList(target, [], "No top risks reported.");
		return;
	}
	for (const finding of findings) {
		const item = document.createElement("li");
		item.className = "stack-item";

		const top = document.createElement("div");
		top.className = "stack-top";
		const title = document.createElement("strong");
		title.textContent = finding.title;
		const badge = document.createElement("span");
		badge.className = `badge ${severityClass(finding.verdict)}`;
		badge.textContent = finding.verdict.replace("_", " ");
		top.appendChild(title);
		top.appendChild(badge);

		const meta = document.createElement("div");
		meta.className = "stack-meta";
		meta.textContent = `Category: ${titleCaseLabel(finding.category)}`;

		const summary = document.createElement("p");
		summary.className = "stack-body";
		summary.textContent = finding.summary;

		item.appendChild(top);
		item.appendChild(meta);
		item.appendChild(summary);
		target.appendChild(item);
	}
}

function renderFixSummaryCards(target, steps) {
	target.innerHTML = "";
	if (!steps || steps.length === 0) {
		renderList(target, [], "No fix plan provided.");
		return;
	}
	for (const step of steps) {
		const item = document.createElement("li");
		item.className = "stack-item";

		const top = document.createElement("div");
		top.className = "stack-top";
		const title = document.createElement("strong");
		title.textContent = step;
		top.appendChild(title);

		item.appendChild(top);
		target.appendChild(item);
	}
}

function renderChat(chat) {
	chatMessagesEl.innerHTML = "";
	if (!chat || chat.length === 0) {
		const empty = document.createElement("div");
		empty.className = "note";
		empty.textContent = "No chat messages yet.";
		chatMessagesEl.appendChild(empty);
		return;
	}

	for (const message of chat) {
		const item = document.createElement("article");
		item.className = `chat-message ${message.role}`;
		const meta = document.createElement("div");
		meta.className = "chat-meta";
		const date = message.createdAt ? new Date(message.createdAt) : null;
		const when = date && !Number.isNaN(date.valueOf()) ? date.toLocaleString() : "";
		meta.textContent = `${message.role}${message.relatedCategory ? ` • ${message.relatedCategory}` : ""}${when ? ` • ${when}` : ""}`;
		const content = document.createElement("div");
		content.textContent = message.content;
		item.appendChild(meta);
		item.appendChild(content);
		chatMessagesEl.appendChild(item);
	}
	chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function renderStructuredFixPlan(report) {
	const plan = report.fixPlan;
	fixPlanStepsEl.innerHTML = "";
	if (!plan || !Array.isArray(plan.priorityOrder) || plan.priorityOrder.length === 0) {
		fixPlanMetaEl.textContent = "No generated fix plan yet.";
		fixPlanBannerEl.classList.add("hidden");
		return;
	}

	fixPlanMetaEl.textContent = `Estimated effort: ${titleCaseLabel(plan.estimatedEffort)} | Steps: ${plan.priorityOrder.length}`;
	if (plan.blocksDeployment) {
		fixPlanBannerEl.classList.remove("hidden");
	} else {
		fixPlanBannerEl.classList.add("hidden");
	}

	for (const step of plan.priorityOrder) {
		const card = document.createElement("article");
		card.className = "card fix-step-card";

		const title = document.createElement("h3");
		title.textContent = `#${step.step} ${titleCaseLabel(step.title)}`;
		card.appendChild(title);

		const meta = document.createElement("p");
		meta.className = "stack-meta";
		meta.textContent = `Category: ${titleCaseLabel(step.category)} | Risk reduction: ${titleCaseLabel(step.riskReduction)}`;
		card.appendChild(meta);

		const action = document.createElement("p");
		action.className = "stack-body";
		action.textContent = `Action: ${step.action}`;
		card.appendChild(action);

		const files = document.createElement("p");
		files.className = "stack-meta";
		files.textContent =
			step.files && step.files.length > 0
				? `Files: ${step.files.join(", ")}`
				: "Files: None specified";
		card.appendChild(files);

		fixPlanStepsEl.appendChild(card);
	}
}

function renderCategoryCards(report) {
	categoryCardsEl.innerHTML = "";
	for (const category of CATEGORIES) {
		const findings = categoryFindings(report.findings ?? [], category);
		let categoryVerdict = "unknown";
		if (findings.some((f) => f.verdict === "blocker")) categoryVerdict = "blocker";
		else if (findings.some((f) => f.verdict === "needs_attention")) categoryVerdict = "needs_attention";
		else if (findings.length > 0 && findings.every((f) => f.verdict === "pass")) categoryVerdict = "pass";
		else if (findings.length === 0) categoryVerdict = "unknown";

		const isUnavailable = report.executiveSummary?.toLowerCase().includes("category review failed");
		let stateLabel = "Needs attention";
		if (categoryVerdict === "pass") {
			stateLabel = findings.length > 0 ? "No issues found" : "No issues found";
		} else if (categoryVerdict === "needs_attention" || categoryVerdict === "blocker") {
			stateLabel = "Needs attention";
		} else if (isUnavailable) {
			stateLabel = "Unavailable";
		} else if (findings.length === 0) {
			stateLabel = "Insufficient data";
		}

		const card = document.createElement("article");
		card.className = `card category-card category-${severityClass(categoryVerdict)}`;

		const title = document.createElement("h3");
		title.textContent = category.replace("_", " ");
		card.appendChild(title);

		const badge = document.createElement("div");
		badge.className = `badge ${severityClass(categoryVerdict)}`;
		badge.textContent = stateLabel;
		const icon = document.createElement("span");
		icon.className = `status-icon ${severityIconClass(stateLabel)}`;
		badge.prepend(icon);
		if (stateLabel === "Unavailable") {
			badge.title = "This category could not be evaluated with the available data.";
		}
		card.appendChild(badge);

		const count = document.createElement("p");
		count.textContent = `${findings.length} finding(s)`;
		card.appendChild(count);

		categoryCardsEl.appendChild(card);
	}
}

function renderReport(state) {
	const report = state.report;
	hasReport = Boolean(report);
	if (!report) {
		resultsPanelEl?.classList.add("hidden");
		chatSendBtn.disabled = true;
		chatInput.disabled = true;
		fixPlanMetaEl.textContent = "No generated fix plan yet.";
		fixPlanBannerEl.classList.add("hidden");
		fixPlanStepsEl.innerHTML = "";
		return;
	}
	resultsPanelEl?.classList.remove("hidden");

	overallScoreEl.textContent = String(verdictScore(report.overallVerdict));
	setBadge(overallVerdictEl, report.overallVerdict);
	const findings = report.findings ?? [];
	const issueCount = findings.filter((f) => f.verdict !== "pass").length;
	const topRisksPreview = [...findings]
		.filter((f) => f.verdict !== "pass")
		.sort((a, b) => {
			const rank = { blocker: 0, needs_attention: 1, unknown: 2, pass: 3 };
			return rank[a.verdict] - rank[b.verdict];
		})
		.slice(0, 2)
		.map((risk) => `${titleCaseLabel(risk.category)}: ${risk.title}`);
	const analyzedLine = report.ingestion?.selectedFileCount
		? `Analyzed ${report.ingestion.selectedFileCount} relevant files.`
		: "Analyzed available relevant files.";
	executiveSummaryEl.textContent = `${analyzedLine} ${issueCount} issue(s) identified. ${topRisksPreview.length > 0 ? `Top risks: ${topRisksPreview.join(" | ")}.` : "No major risks surfaced."}`;

	renderCategoryCards(report);

	const sortedRisks = [...(report.findings ?? [])]
		.sort((a, b) => {
			const rank = { blocker: 0, needs_attention: 1, unknown: 2, pass: 3 };
			return rank[a.verdict] - rank[b.verdict];
		})
		.slice(0, 5);
	renderRiskCards(topRisksEl, sortedRisks);
	renderFixSummaryCards(fixPlanEl, report.recommendedNextSteps ?? []);
	renderStructuredFixPlan(report);

	const ingestion = report.ingestion;
	if (!ingestion) {
		ingestionMetaEl.textContent = "No ingestion metadata available.";
		renderList(skippedFilesEl, [], "No skipped files.");
		renderChat(state.chat ?? []);
		currentSessionId = state.sessionId || currentSessionId;
		setChatLoading(false);
		chatSendBtn.disabled = isRunning || !hasReport;
		return;
	}

	const total = ingestion.totalFilesCount ?? "-";
	const strategy = ingestion.selectionStrategy ?? "default";
	ingestionMetaEl.textContent = `Source: ${ingestion.source} | Total: ${total} | Selected: ${ingestion.selectedFileCount} | Skipped: ${ingestion.skippedFileCount} | Strategy: ${strategy}`;
	const skippedItemsAll = (ingestion.skippedFiles ?? []).map(
		(item) => `${item.path} — ${item.reason}`,
	);
	const skippedPreview = skippedItemsAll.slice(0, 10);
	if (skippedItemsAll.length > 10) {
		skippedPreview.push(`...and ${skippedItemsAll.length - 10} more`);
	}
	renderList(skippedFilesEl, skippedPreview, "No skipped files.");
	if (ingestionSummaryEl) {
		ingestionSummaryEl.textContent = `${ingestion.skippedFileCount} files skipped (filtered by rules)`;
	}
	if (ingestionDetailsEl) {
		ingestionDetailsEl.open = false;
	}
	renderChat(state.chat ?? []);
	currentSessionId = state.sessionId || currentSessionId;
	setChatLoading(false);
	chatSendBtn.disabled = isRunning || !hasReport;
}

async function apiJson(path, init) {
	const response = await fetch(path, {
		headers: { "content-type": "application/json" },
		...init,
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(data.error || `Request failed (${response.status})`);
	}
	return data;
}

async function pollReview(sessionId) {
	clearPolling();
	pollTimer = window.setInterval(async () => {
		try {
			const state = await apiJson(`/api/reviews/${sessionId}`);
			reviewStatusEl.textContent = state.status || "-";
			renderReport(state);
			if (state.error) {
				showError(state.error);
				setStatus("Review finished with an error.");
				clearPolling();
				setBusy(false);
				return;
			}
			if (state.status === "done") {
				setStatus("Review complete.");
				clearPolling();
				setBusy(false);
				chatSendBtn.disabled = !hasReport;
			}
		} catch (error) {
			showError(error instanceof Error ? error.message : "Polling failed.");
			clearPolling();
			setBusy(false);
		}
	}, POLL_INTERVAL_MS);
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	if (isRunning) return;

	clearError();
	setBusy(true);
	setStatus("Starting review session...");

	try {
		const repoUrl = repoUrlInput.value.trim();
		const prRaw = prNumberInput.value.trim();
		const githubToken = githubTokenInput.value.trim();

		const startPayload = { repoUrl };
		if (prRaw) {
			const n = Number(prRaw);
			if (!Number.isInteger(n) || n < 1) {
				throw new Error("PR number must be a positive integer.");
			}
			startPayload.prNumber = n;
		}

		const startResult = await apiJson("/api/reviews/start", {
			method: "POST",
			body: JSON.stringify(startPayload),
		});
		const sessionId = startResult.sessionId;
		currentSessionId = sessionId;
		hasReport = false;
		sessionIdEl.textContent = sessionId;
		setStatus("Queueing analysis workflow...");

		const analyzePayload = {};
		if (githubToken) {
			analyzePayload.githubToken = githubToken;
		}
		githubTokenInput.value = "";

		const analyzeResult = await apiJson(`/api/reviews/${sessionId}/analyze`, {
			method: "POST",
			body: JSON.stringify(analyzePayload),
		});
		workflowIdEl.textContent = analyzeResult.workflowInstanceId || "-";
		reviewStatusEl.textContent = analyzeResult.status || "queued";
		setStatus("Workflow queued. Polling review status...");
		await pollReview(sessionId);
	} catch (error) {
		showError(error instanceof Error ? error.message : "Review request failed.");
		setStatus("Failed to start review.");
		setBusy(false);
	}
});

demoBtn.addEventListener("click", async () => {
	if (isRunning) return;
	clearError();
	setBusy(true);
	setStatus("Starting demo review...");
	try {
		const demoResult = await apiJson("/api/demo/review", { method: "POST" });
		const sessionId = demoResult.sessionId;
		currentSessionId = sessionId;
		hasReport = false;
		sessionIdEl.textContent = sessionId;
		workflowIdEl.textContent = demoResult.workflowInstanceId || "-";
		reviewStatusEl.textContent = demoResult.status || "queued";
		setStatus("Demo workflow queued. Polling review status...");
		await pollReview(sessionId);
	} catch (error) {
		showError(error instanceof Error ? error.message : "Demo review failed.");
		setStatus("Failed to start demo review.");
		setBusy(false);
	}
});

chatForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	if (!currentSessionId || isChatLoading) return;

	const message = chatInput.value.trim();
	if (!message) return;

	clearError();
	setChatLoading(true);
	setStatus("Generating remediation guidance...");

	try {
		const result = await apiJson(`/api/reviews/${currentSessionId}/chat`, {
			method: "POST",
			body: JSON.stringify({ message }),
		});
		chatInput.value = "";
		renderChat(result.chat ?? []);
		setStatus("Remediation response ready.");
	} catch (error) {
		showError(error instanceof Error ? error.message : "Chat request failed.");
		setStatus("Chat failed.");
	} finally {
		setChatLoading(false);
	}
});
