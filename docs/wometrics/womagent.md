# WOMAgent

WOMAgent navigates a reconstructed scene, flags visible failures, investigates their layer and source cutout, tests an existing repair, and independently verifies the result over the complete frozen walkthrough. It runs alongside WOMetrics. Its findings and successful repairs are diagnostics; a completed workflow does not assign a whole-world Par score.

The investigator and verifier are independently selectable adapters. The initial adapters are **Muse Spark 1.3** and **Muse Wonder 1.0**, using the existing server-side `MUSE_API_KEY`. Spark is the default for both roles. Choosing the same model still uses separate verifier requests, with before/after evidence and no investigator conversation.

## Run a workflow

Open `#/agents` and choose Start. Review the world, investigator, verifier, spend limit, view limit and generation option. Ordinary owners can observe their workflows; administrators can start paid execution. Cancel remains available on live detail.

The CLI uses these same HTTP contracts and never executes the runtime in a separate process:

```sh
npm run wom:agent -- catalog
npm run wom:agent -- start --world WORLD_ID --max-usd 2 --wait
npm run wom:agent -- start --world WORLD_ID --agent muse-wonder-1.0 --verifier muse-spark-1.3 --max-usd 2
npm run wom:agent -- status --world WORLD_ID --run RUN_ID
npm run wom:agent -- cancel --world WORLD_ID --run RUN_ID
```

Use `--base http://127.0.0.1:8788` for another local server. A signed-in server accepts `WOM_AGENT_API_TOKEN` as the caller's bearer session token. The CLI sends it only to the chosen server and does not print it. Model keys stay in the server environment.

Defaults are **$2, 32 agent rounds, 3 repair attempts and 32 captured views**, with new asset generation **off**. The operator can select up to $5, 64 rounds/views and 8 attempts. A zero-dollar run makes no uncached model calls. A view limit that excludes required viewpoints prevents repair and successful completion; omitted or blocked viewpoints are reported explicitly.

## Inspection and repair

The browser uses the existing collider-aware patrol planner: source camera, world offsets, and object-side viewpoints. Every camera pose, vertical field of view, aspect ratio, image size and frame hash is saved before investigation. These are sampled navigation viewpoints; this revision does not grade continuous movement between them. It also replays the cameras of existing open observations, sharing a required view when several flags use the same camera/projection. Spark is allowed to settle after each camera movement, and flat or blocked captures cannot count as clean evidence.

The tools are `navigate`, `inspect_issue`, `ablate_layer`, `attribute_issue`, `inspect_cutout`, `preview_asset`, `list_repairs`, `try_repair`, `verify_issue`, `generate_asset`, `flag_problem`, `defer_issue`, `defer_issues`, and `finish_run`.

Layer ablation is temporary and always restored. Ray votes are hypotheses: visual investigation may attribute a flag to another scene layer, recorded as agent attribution. Tight normalized boxes and confidence of at least 0.65 are required for automatic flags. The inspector specifically checks for background sheets retained inside gaps, including bicycle wheel spokes. Silhouette overlap alone cannot establish a good wheel reconstruction.

Eligible repairs replace one object's model with an existing alternative, apply a saved placement, or remove green background splats in a localized marked region. Local cleanup requires a boxed `background-in-object` observation with a scene camera and an active Gaussian PLY. It selects green splats projected inside that box, covering at most half the frame and suppressing at most 25% of visible splats. The original asset, positions, other colours and placement remain intact; the derivative's solid collider is rebuilt, then the complete walkthrough is replayed and independently verified before acceptance. Asset previews show the active derivative for its model. This helps remove grass in bicycle wheels while preserving the current spoke/basket detail. It is not a general solution for every colour or representation.

Asset generation, when separately enabled, creates a missing alternative without activating it; a later guarded trial must verify it. No tool can hide an object as a repair, install provider code from a request, change an arbitrary file, or repair the Marble background/depth relief. Problems without a safe action remain open with a follow-up reason; related follow-ups can be deferred together to preserve the run's steps and spend.

Each trial saves the original scene document, layout, composition state, relief and preview before mutation. The local fitter may recompute a candidate; the trial keeps the surrounding scene and other objects frozen. The host reserves verification budget, applies the candidate, checks that unrelated objects and layout overrides stayed intact, and replays every required view with identical camera and projection. Independent verification must report every unique view, confidence of at least 0.8, target resolved, source preserved, and no new regression. Existing unchanged problems do not count as damage caused by this repair. Missing, duplicated, substituted, uncertain or regressed reviews reject the trial.

Returned incomplete structured answers retain their charges, cannot authorize a repair, and are not reused from cache. The host permits one retry with a larger output allowance, inside the same spend cap, and reserves that contingency before a trial. Aborted and unknown network outcomes are never automatically resubmitted. After an accepted repair, the verified source-camera frame becomes the scene preview.

A rejection, exhausted budget, cancellation or interrupted trial restores the original scene, layout and active object state. Paid costs, logs, new alternatives and rejected-candidate evidence remain available. A durable verification receipt precedes observation closure; restart recovery preserves committed changes and finishes ledger closure idempotently. Recovery scans all runs, independently of observation list limits, before the normal server starts listening. Cancel stops new agent/model calls and rolls back any trial. An already-submitted optional generation is allowed to settle and retain its alternative before cancellation completes.

Further sightings on an already repaired object can use `verify_issue`: it checks the current accepted replacement against the original complete walkthrough and closes the sighting only after independent verification. It does not switch assets again.

## API and evidence

| Method and route | Contract |
| --- | --- |
| `GET /api/womagent/catalog` | Adapter IDs, model identities, configuration availability, defaults and `canStart` |
| `POST /api/worlds/:id/womagent/runs` | Options object; `202 {run}` |
| `GET /api/worlds/:id/womagent/runs/:record` | Raw `WomAgentRun`, owner/admin |
| `POST /api/worlds/:id/womagent/runs/:record/cancel` | `{run}`, owner/admin |
| `GET /api/worlds/:id/womagent/settings` | `{enabled, options}`, owner/admin |
| `PUT /api/worlds/:id/womagent/settings` | `{enabled, options}`, admin |

For example, the start body is:

```json
{"adapter":"muse-spark-1.3","verifier":"muse-spark-1.3","maxUsd":2,"maxRounds":32,"maxRepairs":3,"maxViews":32,"allowGeneration":false}
```

Settings are disabled by default. An explicit `enabled: true` runs WOMAgent after a successful or partial build, retaining the world task lock. Agent failure records its reason without failing or refunding an otherwise usable build.

The separate observation adapters provide `GET /api/agents/workflows` and `GET /api/agents/workflows/:world/:record` for admins, and `GET /api/worlds/:id/agent-workflows` and `GET /api/worlds/:id/agent-workflows/:record` for owners. Lists summarize coverage, issues, repairs and trace counts without full frames or transcripts. They never start model calls.

Runs are saved under `data/worlds/:world/womagent/:run/`. Image paths in `WomAgentRun` are relative to their world, served through `/files/:world/:file`. Runs, traces, checkpoints, receipts and images remain private and are served without caching. Only image IDs and evidence paths appear in the trace; image bytes stay in the evidence files. Scene fingerprints include layout overrides, and model cache keys hash actual image bytes.

The internal browser uses an ephemeral, revocable rendering grant limited to the source world's viewer reads/files and observation creation. It cannot reach other worlds, execution, settings or global observation routes, and cannot fall back to the local administrator. The grant is not written to evidence or sent to providers. The browser blocks external origins.

## Add an adapter

Implement the exported [AgentAdapter contract](../../packages/metrics/src/core/agent.ts) and register it server-side with [registerWomAgentAdapter](../../server/src/womagent/adapters.ts). An adapter declares its ID/revision, model/provider identities, required environment names, configuration status, conservative call estimate, and `respond(request)`. Requests contain neutral messages, labelled JPEG/PNG images, tool definitions, optional JSON schema, output limit and abort signal. Responses contain text, structured tool calls and actual USD usage.

The host owns budgeting, serial tool execution, checkpoints, replay, acceptance and completion. Custom adapters therefore use the same repair tools and persistent [WomAgentRun contract](../../server/src/womagent/types.ts), without introducing a provider SDK into the core metrics package. HTTP clients can select only registered adapters; arbitrary provider URLs and credential values are not execution options.

Run `npm run test:womagent` for hermetic runtime, adapter, access, cancellation and recovery checks. The observation suites are `npm run test:agents` and `npm run test:agents:ui`.
