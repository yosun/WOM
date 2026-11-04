# Contributing a setup to WOMetrics

Every method uses the same report shell: **WOMetrics opens by default**, with the current
WOMPar reference score and the generation's measurements. **Build Details** is a separate tab
for progress, intermediate artifacts, model/agent traces and refinement controls. It remains
owner-only. Explicit Refine links open that tab; ordinary WOMetrics links open the report,
including while a generation is running.

The reference score is **WOMPar 0.1: Par 0** on the named frozen pilot course. Negative beats
par. A single generation with no complete-course result is labeled **Not ranked**. Object IoU,
asset checks or a good first frame must never be substituted for an overall Par result.

## The common contribution format

A contribution consists of:

1. A versioned **setup descriptor**, `wom-agent-setup/1`: stable method ID, label and revision;
   runner; rendering adapter; model and agent roles/tools; environment variable names; and a
   hashed configuration file for prompts, parameters, generation seeds and resource limits.
2. Its **frozen world outputs and review evidence** for every required course scene/trial,
   using the representation-independent [Par output/bundle contract](../wom-par/protocols/global-v1.md#files-and-reproduction).
3. A **Par submission** with the course digest, the matching method identity, the setup
   descriptor and actual blind comparison ballots. The standard scorer imports this evidence
   and emits the same Global scorecard/report for every method.

Meshes, splats, radiance fields and other renderable worlds are eligible. You do not need
SAM masks, separate objects, MoGe, Marble, Muse or WOM's pipeline stages. Supply an adapter
that captures your output under the frozen camera/intrinsics/render contract. A method-specific
diagnostic stays in Build Details or is explicitly labeled as an optional measurement.

The [JSON Schema](../../packages/metrics/schema/agent-setup-v1.json) is also served at
`GET /api/wometrics/setup-schema`. [AgentSetup](../../packages/metrics/src/core/setup.ts)
and `assertAgentSetup` are exported by `@wom/metrics/core`. The facts page links this schema and
its own safe report JSON at `GET /api/worlds/<id>/metrics` (`wometrics/1`). Existing evaluation
files remain readable without a setup descriptor; new contributions should include one.

```json
{
  "schema": "wom-agent-setup/1",
  "id": "my-world-agent",
  "label": "My world agent",
  "revision": "<code/model/prompt/configuration revision>",
  "runner": {
    "kind": "command",
    "argv": ["python", "my_agent.py", "--photo", "{photo}", "--output", "{output}"]
  },
  "adapter": { "id": "my-renderer", "revision": "v1" },
  "models": [{ "id": "my-model-snapshot", "provider": "my-provider", "role": "Scene reconstruction" }],
  "agents": [{ "id": "reconstructor", "role": "Build the world", "model": "my-model-snapshot", "tools": ["render", "inspect", "revise"] }],
  "environment": ["OPENAI_API_KEY"],
  "configuration": { "path": "configuration.json", "sha256": "<64 lowercase hex characters>" }
}
```

An HTTP runner may instead declare `{"kind":"http","path":"/api/worlds"}`. Runner metadata
describes how generation is invoked; the scoring importer does **not** execute it. Adapters
translate a representation into the common evidence contract; they cannot change the path,
hide failed views or regenerate the world independently at each camera. Keys stay in the
runner's environment: descriptors list their names, never their values.

Generate a submission template, put the descriptor in `submission.setup`, and keep
`setup.id`, `setup.label` and `setup.revision` identical to `submission.method`:

```sh
npm run bench:global -- --template /tmp/my-submission.json
npm run bench:global -- --submissions /path/to/finished-submission.json
```

The template includes the standard descriptor and an empty comparison list, so it remains
unranked until real evidence and ratings are supplied. A declared configuration file is
verified by content hash. Submissions archive the setup and accepted ballots with the score;
new entrants never alter an earlier entrant's score.

## Report rules

- Show reference name/version, score, course identity, judging track, pilot/release status and
  actual ballot count together. A reference's zero is an anchor, not an observed challenger win.
- Separate a **method's full-course Par score** from a **single generation's diagnostics**.
  Keep missing measurements null or explicitly unavailable; absent masks/objects do not mean
  zero quality, and unchecked assets do not mean clean.
- Use the same frozen photographs, path, rendering conditions and weighting. Human and model
  judging tracks remain separate. Incomplete evidence/panels cannot produce a global score.
- Keep source-view fidelity, navigation consistency and failure evidence inspectable. Generation
  cost/time are separate from the cost of importing or judging an evaluation.
- Version the setup, adapter, public configuration, scoring protocol and course independently.
  Preserve old outputs and hashes. [WOMPar 0.1](../wom-par/0.1.md) is the initial reference, not a
  requirement to copy its architecture.
