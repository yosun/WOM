# WOMetrics — World Observation Metrics

**How faithfully does a reconstructed 3D world preserve the photo it came from?**
WOMetrics makes that question inspectable: source-view fidelity, placement, asset quality,
camera consistency, failures, cost and time, with saved evidence behind the measurements.
Its global Par protocol compares complete worlds against a frozen reference under the same
camera walkthrough and judging conditions.

**WOMPar is the reference reconstruction system.** **World of a Memory** is the working
photo-to-world application and viewer at [wom.quest](https://wom.quest). This repository
contains all three: the evaluation framework, the reference implementation, and a
**standalone demo you can test with one API key**.

**[Try WOMPar](#try-wompar-with-one-key)** · **[What WOMetrics measures](#what-wometrics-measures)** ·
**[Contribute a method](#contribute-your-own-method)** · **[Run the full app](#run-world-of-a-memory)**

## Try WOMPar with one key

Requires **Node 22.18+**. The standalone script needs **no dependency installation or running
app server**. Its public example files are included in the repository; no private worlds or
local benchmark cache are needed.

```sh
git clone https://github.com/yosun/WOM.git
cd WOM
node demo/wompar/wompar.mjs --offline
```

Open the printed `report.html` path: the source photo, two saved reconstruction renders,
measurements and evidence hashes are ready to inspect. `results.json` holds the same report
as data. Offline mode is free and makes no network requests, even if keys are configured.

For a live test, create `.env` from [.env.example](.env.example) if you do not already have
one, then fill in **just one** key:

| Your key | What the standalone demo runs |
| --- | --- |
| `MUSE_API_KEY` | Muse compares two saved reconstruction renders against the source photo |
| `OPENAI_API_KEY` | OpenAI runs the same comparison |
| `GEMINI_API_KEY` | Gemini runs the same comparison, with no cloud CLI setup |
| `ANTHROPIC_API_KEY` | Claude runs the same comparison |
| `AI3D_API_KEY` | Generates a new Marble draft world from the public photo and downloads its SPZ |

```sh
node demo/wompar/wompar.mjs
```

That is enough. Other keys are optional. Auto mode uses only the first configured provider
in this order: Muse, OpenAI, Gemini, Anthropic, AI3D. To choose explicitly:

```sh
node demo/wompar/wompar.mjs --provider openai
node demo/wompar/wompar.mjs --provider ai3d
node demo/wompar/wompar.mjs --check
```

Vision review makes two paid calls to one provider, swapping A/B order. AI3D mode submits
one paid generation job, checks its reservation price first, saves recovery information and
downloads the smallest returned SPZ. Each run writes its own report under the ignored
`data/wompar-demo/` directory. Keys stay in your environment; the browser report contains no
credentials. Provider failures preserve a partial report and do not trigger paid retries.

**The demo reports numeric source-view Par:** its selected reference is **0**, negative
candidate scores beat it, and positive scores trail it. Both A/B comparisons must finish;
the number appears in the HTML report, terminal and JSON `par` field. Offline and AI3D-only
modes show the reference's 0 and leave the unreviewed candidate unscored.

**Its global score stays “Not ranked.”** The public case shows the scripted object-split
experiment, not the frozen whole-world pilot course.
One view or one reviewing model cannot establish a full-course WOMPar result. Generating
with AI3D alone demonstrates Marble; the full WOMPar app recipe requires Muse and AI3D.

See the **[standalone demo guide](demo/wompar/README.md)** for custom photos/renders, model
selection, AI3D job resumption and all options. The [interactive object-split demo](demo/object-split/README.md)
also includes a live 3D comparison of the public case.

```sh
node --test demo/wompar/wompar.test.mjs
```

These tests require no keys or npm packages. [CI](.github/workflows/wompar-demo.yml) runs
them and the offline demo from a fresh checkout without installing the app.

## What WOMetrics measures

| Evaluation | Evidence and output |
| --- | --- |
| **Whole-world Par** | Complete reconstructions against a frozen reference, using identical source photos, camera paths, rendering conditions and blind comparisons |
| **Source-view fidelity** | Source/reconstruction comparisons, silhouette overlap and colour/depth errors where the method provides that evidence |
| **Object placement** | Silhouette IoU, absolute ground gap, tilt and overlays for the same saved objects/assets |
| **Asset quality** | Clean/minor/contaminated verdicts, retained turntables and comparison with human labels |
| **Camera and navigation** | Camera field of view against photo lens data, walkthrough evidence and recorded observations |
| **Resources and reliability** | Completed/skipped/failed stages, measurement coverage, recorded generation spend, wall time and output size |

In the app, every generation opens its **WOMetrics** report by default at
`/u/<handle>/<world>/build`. **Build Details** is the separate owner-only tab for pipeline
progress, artifacts, traces and refinement controls. The cross-world benchmark dashboard is
at `#/bench`. Both read saved evidence without initiating paid model calls.

Missing evidence stays missing. An unchecked asset is not clean; a method without separate
objects does not get an invented object-IoU score. Stage diagnostics remain separate from
the whole-world score.

The reusable framework is **[@wom/metrics](packages/metrics/README.md)**. Declare a task,
plug in a model, agent, solver, script or human subject, and retain comparable runs, reports,
paid-call caches and the spend ledger. Whole-world evaluation accepts meshes, splats and
other renderable representations through the common capture adapter contract.

## WOMPar: the reference and the score

**WOMPar 0.1 defines Par 0. Negative beats it.** With candidate preference `p`, counting
ties as half a win:

```text
Par = 100 × (1 − 2p)        range: −100 … +100
```

A score of −20 means 60% preference against the reference on that course, not 20% better
geometric accuracy. Scoring averages judges, trials, unique source photographs and fixed
category weights. A partial course cannot rank. Human and provisional model judging tracks
remain separate; model panels must see both A/B orders.

The [initial four-photo pilot](docs/wom-par/0.1.md#initial-frozen-course-wompar-01-pilot)
anchors the saved reference at **0 by exact identity, with zero actual ballots**. Its source
worlds and walkthrough captures are private local assets, so a fresh checkout should start
with the public demo above. The pilot is a development sample, not population validation or
evidence of a challenger win.

When you have the complete frozen assets and real submissions:

```sh
npm install
npm run bench:global
npm run bench:global -- --template /tmp/my-submission.json
npm run bench:global -- --submissions /path/to/finished-submission.json
```

The importer verifies evidence and provenance hashes; it does not generate missing worlds
or invent judgments. The existing `bench:par` command is a separate saved-asset fitter
experiment, which also requires local world assets. See the [WOMPar reference specification](docs/wom-par/0.1.md)
and [global evaluation protocol](docs/wom-par/protocols/global-v1.md).

## Contribute your own method

Use any model, agent, pipeline or renderable world representation. Contributions share a
versioned setup descriptor, frozen outputs and review evidence, and a Par submission tied
to the same course and judging track. You can supply your own renderer through an adapter.

Start with **[Contributing a setup to WOMetrics](docs/wometrics/contributing.md)** and the
[setup JSON Schema](packages/metrics/schema/agent-setup-v1.json). A descriptor records the
method/revision, runner, rendering adapter, models, agent tools and environment-variable
names. It contains no key values. A generation without complete-course evidence remains
**Not ranked** in the common report.

## Run World of a Memory

The complete application turns a photo into an explorable world with Muse planning,
SAM segmentation, Muse Image edits, MoGe depth, separately generated objects, Marble and
local placement. It includes the viewer, WOMetrics reports, observations and refinement.

This complete recipe requires **both `MUSE_API_KEY` and `AI3D_API_KEY`**. OpenAI is optional
for experimental Sol planning/placement. Gemini and Anthropic are selectable in the standalone
evaluation demo; they are not replacement providers for every app pipeline stage.

```sh
# Create .env from .env.example and fill in MUSE_API_KEY and AI3D_API_KEY.
npm install
npm run dev
# Open http://localhost:5173
```

On localhost, no sign-in or database setup is needed. See the
**[application and implementation guide](docs/world-of-a-memory.md)** for pipeline details,
head/body splitting, camera matching, viewer controls, accounts, credits and deployment.

## Documentation

| Start here | What it covers |
| --- | --- |
| [Standalone WOMPar demo](demo/wompar/README.md) | One-key setup, public saved case, custom comparisons, AI3D generation and tests |
| [WOMetrics framework](packages/metrics/README.md) | Tasks, subjects, scoring, paid calls, reports, HTTP routes and dashboard |
| [Contribution contract](docs/wometrics/contributing.md) | A common setup, artifact and report format for any contributed method |
| [WOMPar 0.1](docs/wom-par/0.1.md) | Reference recipe, frozen pilot course, placement revisions and measured limitations |
| [Global Par protocol](docs/wom-par/protocols/global-v1.md) | Evidence, camera capture, weighting, judging, uncertainty and reproducibility |
| [World of a Memory application](docs/world-of-a-memory.md) | The full application, pipeline, viewer, running locally and on a server |
| [Object-split demo](demo/object-split/README.md) | Interactive public case with 3D assets and saved measurements |
