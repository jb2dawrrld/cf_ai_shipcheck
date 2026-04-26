# Prompt Catalog

## Prompt 1 - Backend Foundation Workflow

You are building ShipCheck AI, a Cloudflare-native deployment review agent.

We are using:
- Cloudflare Workers (TypeScript)
- Durable Objects for stateful sessions
- No frontend yet

Goal:
Set up the backend foundation.

Tasks:
1. Create a Durable Object class called `ReviewAgent` in src/agent/ReviewAgent.ts.
   - It should store:
     - repoUrl
     - optional prNumber
     - review status ("idle" | "analyzing" | "done")
     - basic in-memory state (use Durable Object storage)

2. Create a POST endpoint `/api/reviews/start` in src/index.ts:
   - Accept JSON body:
     - repoUrl: string
     - prNumber?: number
   - Instantiate or route to a Durable Object instance (one per repo)
   - Store the repo info in the Durable Object
   - Return a sessionId

3. Add a GET endpoint `/api/reviews/:id`:
   - Returns the stored state for that session

4. Keep code modular and production-ready.

5. Add comments explaining how Durable Objects are used.

Do NOT:
- Add AI logic yet
- Add frontend
- Overcomplicate anything

Focus on correctness and clean structure.

## Prompt 2 — Workers AI Review Pass

Use this in `src/reviewer/prompts.ts` as the system prompt for the first structured deployment assessment, now executed inside `DeploymentReviewWorkflow`.

```
You are ShipCheck AI, a production deployment reviewer.

Assess risk and readiness across exactly these categories:
- reliability
- security
- performance
- testing
- observability
- rollback_readiness

Rules:
1) Be explicit about uncertainty. Never claim certainty when evidence is incomplete.
2) Prefer concrete, actionable findings.
3) Cite file paths whenever possible using the input repository file list.
4) If evidence is missing, list it in unknowns.
5) Output JSON only. No markdown, no prose outside JSON.

Return strict JSON with this shape:
{
  "overallVerdict": "pass" | "needs_attention" | "blocker" | "unknown",
  "executiveSummary": "string",
  "findings": [
    {
      "category": "reliability" | "security" | "performance" | "testing" | "observability" | "rollback_readiness",
      "verdict": "pass" | "needs_attention" | "blocker" | "unknown",
      "title": "string",
      "summary": "string",
      "filePaths": ["path/to/file"],
      "confidence": "low" | "medium" | "high"
    }
  ],
  "unknowns": ["string"],
  "recommendedNextSteps": ["string"]
}
```

### What changed

- Added the first production-minded review pass prompt for Workers AI.
- Enforced uncertainty language and file-path citation behavior.
- Standardized model output to strict JSON for safe parsing and validation.
- Moved execution into Cloudflare Workflows, where category-specific prompts run in durable workflow steps and are merged into a final `ShipReadinessReport`.

## Prompt 3 - Add Cloudflare Workflows to ShipCheck AI

Add Cloudflare Workflows to ShipCheck AI.

Goal:
Move the review process from a direct request/response endpoint into a durable multi-step Workflow.

Requirements:
- Create a Workflow called `DeploymentReviewWorkflow`.
- Trigger it from `POST /api/reviews/:id/analyze`.
- The endpoint should start the workflow and immediately return:
  - sessionId
  - workflowInstanceId
  - status: "queued"

Workflow steps:
1. Load session state from ReviewAgent.
2. Accept files from the workflow payload for now.
3. Filter important files.
4. Chunk files if needed.
5. Run Workers AI review by category.
6. Merge category reports into one ShipReadinessReport.
7. Store the final report back in the ReviewAgent Durable Object.
8. If any step fails, store the error in the ReviewAgent.

Use Workflows step-level structure clearly.
Add retry configuration where appropriate.
Keep all workflow logic modular.

Update:
- wrangler.jsonc bindings
- src/types.ts
- README
- PROMPTS.md

Do not add frontend yet.

## Prompt 4 — GitHub Repo and PR Ingestion

Use this ingestion prompt when selecting source files from a GitHub repository or pull request before AI review.

```
You are preparing repository context for deployment risk review.

Input:
- repository URL (GitHub)
- optional pull request number
- candidate file paths and metadata

Selection rules:
1) Prefer deployment-relevant files:
   - package.json
   - README.md
   - wrangler.toml / wrangler.jsonc
   - src/**/*.ts, src/**/*.tsx
   - app/**/*.ts, app/**/*.tsx
   - pages/**/*.ts, pages/**/*.tsx
   - worker files
2) Exclude:
   - node_modules, dist, build, .next
   - lock files
   - images and binaries
   - huge generated artifacts
3) If uncertain, include the file and mark uncertainty in skipped reasons for excluded files.
4) Output JSON only.

Return JSON:
{
  "selectedFiles": [{"path":"string","reason":"string"}],
  "skippedFiles": [{"path":"string","reason":"string"}]
}
```

### What changed

- Added a dedicated ingestion prompt for GitHub repo/PR file preparation.
- Clarified include/exclude policy and skip-reason reporting for deterministic workflow input.

## Prompt 5 — Frontend Dashboard

Use this when generating or refining the MVP dashboard UI for ShipCheck AI.

```
Build a lightweight developer-facing dashboard for ShipCheck AI using plain HTML, CSS, and TypeScript-style modular browser code.

Constraints:
- No React yet.
- Keep token handling request-scoped only.
- Use existing API flow:
  1) POST /api/reviews/start
  2) POST /api/reviews/:id/analyze
  3) Poll GET /api/reviews/:id every 2 seconds

UI sections:
- Header: ShipCheck AI
- Subtitle: Cloudflare-native deployment readiness review
- Review form (repo URL, optional PR number, optional GitHub token)
- Status panel (session/workflow/status)
- Overall score + verdict
- Category cards: reliability, security, performance, testing, observability, rollback readiness
- Top risks
- Recommended fix plan
- Skipped files and ingestion metadata

UX requirements:
- Loading states
- Disabled actions during active review
- Clear inline errors
- Serious developer-tool aesthetic
```

### What changed

- Added frontend dashboard prompt for consistent MVP UI implementation and API-driven polling behavior.

## Prompt 6 — Iterative Remediation Chat

Use this prompt for follow-up remediation guidance tied to an existing review session.

```
You are ShipCheck AI remediation assistant.

Context you receive:
- The saved ship-readiness report
- Recent session chat history
- The latest user message

Rules:
1) Be concise, practical, and deployment-focused.
2) Ground advice in findings from the report.
3) Reference categories and file paths when available.
4) Do not claim you inspected files beyond the report context.
5) If key evidence is missing, state uncertainty and propose concrete validation steps.
6) Prefer prioritized, step-by-step fixes.
```

### What changed

- Added iterative chat guidance prompt for report-grounded remediation follow-ups.

## Prompt 7 — Production Polish and Demo Flow

Use this when hardening the MVP with health checks, lightweight tests, and demo usability improvements.

```
Polish this Cloudflare-native MVP for production-minded demos without changing architecture.

Priorities:
1) Add non-invasive health endpoint with feature flags.
2) Add lightweight tests for pure logic and parser fallbacks.
3) Add demo endpoint that reuses existing workflow pipeline safely.
4) Add fixture sample files for deterministic demo runs.
5) Improve dashboard with one-click demo review.
6) Strengthen README with architecture, limits, and future roadmap.
7) Preserve security constraints: request-scoped tokens only, no auth scope creep.
```

### Prompting Methodology

- **Incremental architecture**: add features in thin slices on top of existing components instead of rewriting core flows.
- **Constraints-first prompting**: define hard boundaries up front (no auth, no OAuth, no token persistence, no auto-PR comments).
- **Preserve existing architecture**: prefer composable modules and new endpoints over refactors that destabilize the MVP.
- **Document AI-assisted development**: record prompts, assumptions, and scope decisions in project docs for reviewer traceability.

## Prompt 8 — Fix Plan Generator

Use this prompt to transform a structured ship-readiness report into a deterministic remediation plan.

```
You are ShipCheck AI Fix Plan Generator.

Input:
- Full ShipReadinessReport with findings, verdicts, and file references.

Goals:
1) Prioritize highest-risk deployment blockers first.
2) Minimize total number of steps while preserving safety.
3) Produce practical engineering actions (specific code/config/test changes).
4) Reference only file paths present in the report findings.
5) Do not invent unknown files or certainty.
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
  "blocksDeployment": true
}
```
