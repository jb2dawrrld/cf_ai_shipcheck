# ShipCheck AI

ShipCheck AI is a Cloudflare-native deployment readiness reviewer. It ingests a GitHub repository or pull request, runs a multi-step workflow with Workers AI, stores state in Durable Objects, and provides an interactive dashboard with iterative remediation chat.

## Why this is Cloudflare-native

- `Workers` provide globally distributed API + dashboard hosting.
- `Durable Objects` provide per-session stateful consistency.
- `Workflows` provide durable, retryable multi-step analysis orchestration.
- `Workers AI` powers structured review and remediation chat.
- `Assets` hosts the frontend dashboard in the same project.

## Architecture (text diagram)

`Browser Dashboard (Assets)`
-> `Worker API (/api/*)`
-> `ReviewAgent Durable Object (session state, report, chat)`
-> `DeploymentReviewWorkflow (durable steps + retries)`
-> `Workers AI (analysis + remediation responses)`
-> `GitHub API (repo/PR ingestion when needed)`

## Cloudflare services used (and why)

- `Workers`: API routing, health, demo endpoint, and static frontend integration.
- `Durable Objects`: authoritative session state (`status`, `report`, `chat`).
- `Workflows`: non-blocking analysis pipeline with step boundaries and retries.
- `Workers AI`: category review generation + practical chat follow-ups.
- `Assets`: simple production deploy for the MVP dashboard.

## API quick reference

- `GET /api/health` - service health and feature flags.
- `POST /api/reviews/start` - create/update review session.
- `POST /api/reviews/:id/analyze` - queue workflow using manual files or GitHub ingestion.
- `GET /api/reviews/:id` - retrieve session state, report, and chat history.
- `POST /api/reviews/:id/chat` - iterative remediation chat (requires report).
- `POST /api/demo/review` - demo-only flow using fixture files.

## Fix Plan Generation

After category reports are merged, the workflow runs a dedicated fix-plan generation stage to produce a structured, ordered remediation plan:

- `priorityOrder`: minimal set of actionable steps in risk order
- `estimatedEffort`: low/medium/high rollout effort
- `blocksDeployment`: explicit deploy gate signal

Unlike raw AI suggestions, this plan is constrained to a strict schema, grounded in existing findings, and designed to be execution-ready (specific actions + referenced files where known).

## Local development

1. Ensure `wrangler.jsonc` has bindings:
   - `REVIEW_AGENT` (Durable Object)
   - `AI` (Workers AI)
   - `DEPLOYMENT_REVIEW_WORKFLOW` (Workflow)
2. Authenticate:
   - `npx wrangler login`
3. Start:
   - `npm run dev`
4. Open dashboard:
   - [http://localhost:8787](http://localhost:8787)

## Frontend flow

1. Enter repo URL, optional PR number, optional GitHub token.
2. Click **Start Review**.
3. UI calls:
   - `POST /api/reviews/start`
   - `POST /api/reviews/:id/analyze`
   - polls `GET /api/reviews/:id` every 2 seconds.
4. After report completion, use remediation chat for follow-up questions.

## Demo flow

Use the dashboard **Try Demo Review** button, or call:

```bash
curl -X POST http://localhost:8787/api/demo/review
```

This endpoint is for demos only. It uses fixture files from `fixtures/sample-files` and a fake repo URL (`https://github.com/demo/shipcheck-sample`), then queues the normal workflow.

## Security notes

- GitHub token is optional.
- Tokens are request-scoped and are not persisted in Durable Object storage.
- No auth/OAuth is implemented in this MVP.

## Example chat questions

- `What should I fix first?`
- `Explain the rollback risk.`
- `Give me a step-by-step fix plan.`

## Lightweight tests

Pure-logic tests are included in `tests/`:

- `github.test.ts` (URL parsing + file selection rules)
- `reviewer.test.ts` (report parsing fallback behavior)
- `chat.test.ts` (chat message validation)

## Known limitations

- No authentication or multi-tenant access controls yet.
- GitHub API ingestion uses unauthenticated limits unless token is provided.
- Report quality depends on available repository context and model output.
- Frontend is intentionally minimal and non-framework for MVP speed.

## Future improvements

- Auth + role-based project access.
- GitHub OAuth app integration.
- Background notifications for workflow completion.
- Richer scoring, trend history, and diff-aware remediation.
- Optional PR comment generation (explicit opt-in).

## Screenshot placeholder

- `docs/screenshots/dashboard-mvp.png`
