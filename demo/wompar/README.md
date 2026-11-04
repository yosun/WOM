# WOMetrics / WOMPar standalone demo

Try **World Observation Metrics** on a public saved WOM reconstruction, or generate a new
world through AI3D. **One API key is enough.** There is also a free offline mode.

Requires **Node 22.18+**. Run from a clone or downloaded ZIP of this repository. There is no
`npm install`, build, app server, database, Clerk account, Stripe setup or cloud CLI to configure.
The script uses Node built-ins and the public files already in the repository.

## Start here

```sh
git clone https://github.com/yosun/WOM.git
cd WOM
node demo/wompar/wompar.mjs --offline
```

Open the printed `report.html` path in your browser. It contains the source photograph,
reference and candidate renders, saved measurements, evidence hashes and a Par scorecard.
`results.json` is the machine-readable version. Both are saved in a new folder under
`data/wompar-demo/`, which is ignored by Git. Offline mode makes **zero network requests**,
even when keys are configured.

## Add just one key

Copy the root [environment template](../../.env.example) to `.env` if you do not have one yet.
Fill in **one** of these variables; leave the others empty:

| Key | What you can test with that key alone |
| --- | --- |
| `MUSE_API_KEY` | Muse Spark compares the two public saved reconstruction renders with their source photograph |
| `OPENAI_API_KEY` | OpenAI performs the same comparison |
| `GEMINI_API_KEY` | Gemini performs the same comparison, directly through its API; no Vertex/gcloud setup |
| `ANTHROPIC_API_KEY` | Claude performs the same comparison |
| `AI3D_API_KEY` | Generate a new Marble draft world from the public photo; save the job, billing and a downloaded SPZ |

```sh
node demo/wompar/wompar.mjs
```

The demo reads `.env`, then `.env.local` in the repository root; exported shell variables
take precedence. The legacy `MODEL_API_KEY` and `OPENAI_KEY` aliases also work. It never
writes credentials or sends them to a browser. Do not put API keys in CLI arguments.

With several keys configured, auto mode selects the first available provider in this order:
**Muse → OpenAI → Gemini → Anthropic → AI3D**. It calls only that provider. Select one explicitly:

```sh
node demo/wompar/wompar.mjs --provider anthropic
node demo/wompar/wompar.mjs --provider ai3d
node demo/wompar/wompar.mjs --check
```

Vision mode makes **two paid requests** to the selected provider: the same source/reference/
candidate comparison in both A/B orders. Each response is validated and saved immediately.
Usage is recorded as the provider returns it; unknown dollar costs are not guessed.
There are no automatic paid retries or fallback calls to another provider. An error exits
nonzero and preserves a partial report.

Defaults: `muse-spark-1.3`, `gpt-6.1-sol`, `gemini-3.8-flash`, `claude-sonnet-5-5`, and
`worldlabs-draft`. Use `--model <accessible-model-id>` or the corresponding
`WOMPAR_MUSE_MODEL`, `WOMPAR_OPENAI_MODEL`, `WOMPAR_GEMINI_MODEL`, `WOMPAR_ANTHROPIC_MODEL`,
`WOMPAR_AI3D_MODEL` variable to select a model your key can access. AI3D mode supports
`worldlabs-draft` and `worldlabs`.

## What this demonstrates

The [public fixture](fixture.json) pins three images and the original measurement file by
SHA-256. They come from the [object-split experiment](../object-split/README.md): the same
portrait reconstructed as one object, or as a separately generated head/body with pixel
alignment and an eye corrector. This lets anyone inspect a real tradeoff: better face detail
from the source camera can coexist with more gaps from the side.

The report separates **saved diagnostic measurements**, **fresh source-view model reviews**,
and **new AI3D generation**. Saved measurements are not recomputed by this script. An AI3D run
does not judge its newly generated world using the saved renders. The experiment's one-object
reference is not the frozen whole-world WOMPar 0.1 course reference.

**The demo reports numeric source-view Par after both live comparisons.** The selected demo
reference has Par **0**. Candidate Par uses `100 × (1 − 2p)`, where `p` is the candidate's
mean preference across both A/B orders, counting a tie as half a win. Negative beats the
reference; positive trails it. Two wins give **−100**, two ties or one win and one loss give
**0**, and two losses give **+100**. JSON stores this as a number in `par`, with
`referencePar: 0` and `parScope: "source-view"`; the HTML report and terminal show the same score.
Offline, AI3D-only and interrupted comparisons leave candidate `par` null because no complete
source-view review is available. The reference's numeric **0** is always shown.

**The demo stays “Not ranked” for global WOMPar.** One photograph and one model seeing two
orders do not meet the complete-course protocol. The source-view score describes only the
supplied renders. WOMPar 0.1 separately defines **Par 0** on its named frozen course; negative beats it.
To evaluate your method formally, use the [common contribution contract](../../docs/wometrics/contributing.md)
and [global Par protocol](../../docs/wom-par/protocols/global-v1.md).

## Compare your own renders

Use a source photo and two renders made with the same camera/framing. JPEG, PNG and WebP
are supported, up to 10 MiB each. All three images are sent to the selected vision provider.
Public fixture measurements are omitted for custom inputs.

```sh
node demo/wompar/wompar.mjs --provider gemini \
  --source /path/to/photo.jpg \
  --reference /path/to/reference.png \
  --candidate /path/to/candidate.png
```

## Generate with AI3D alone

```sh
node demo/wompar/wompar.mjs --provider ai3d
node demo/wompar/wompar.mjs --provider ai3d --source /path/to/photo.jpg
```

This uploads the image and submits **one real world-generation job**, without a separate
language-model key. It checks model availability and the current reservation price first,
with a default reservation ceiling of $2. Change it using `--max-reservation-usd`. The final
provider charge can differ from the reservation. This is the direct Marble demonstration;
the full WOMPar app recipe also includes Muse segmentation/image editing, depth and separate
objects, and requires **both Muse and AI3D**.

The script polls for up to ten minutes, saves the job ID, records the charged amount when
available and downloads the smallest returned SPZ as `world.spz` (maximum 128 MiB). The report
links the local file and AI3D's viewer when one is returned. A job that times out can continue
at AI3D. Resume it without another upload or generation:

```sh
node demo/wompar/wompar.mjs --provider ai3d --resume <job-id>
```

A resumed run does not assume its bundled example photo was the job's original input.
The new report leaves that source hash unverified; retain the original run for input provenance.

If submission's response is lost, the prewritten `job.json` contains the idempotency key.
Use AI3D's `GET /v2/jobs/recovery/{idempotency_key}` to recover the job ID before resuming;
starting a new run without `--resume` intentionally submits a new paid job. A failed or
`submission_unknown` job is never automatically resubmitted. Retained artifact metadata
stays in `job.json`.

## Verify it

```sh
node --test demo/wompar/wompar.test.mjs
node demo/wompar/wompar.mjs --offline
```

The tests use mocked HTTP responses; they need no keys and make no paid calls.
For npm users, `npm run demo:wompar`, `npm run demo:wompar:offline`, and
`npm run test:demo:wompar` are equivalent entry points. Run `--help` for all options.

Adapter references: [OpenAI Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses),
[Gemini REST discovery](https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta),
[Claude Messages](https://platform.claude.com/docs/en/build-with-claude/working-with-messages),
[AI3D world generation](https://api.ai3d.dev/v2/models/worldlabs-draft/llm.txt).
