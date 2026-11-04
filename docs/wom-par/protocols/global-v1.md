# WOMetrics global Par protocol v1

WOMPar 0.1 is the fixed reference. **Its Par is 0. Lower scores are better.** This is a relative
quality measure for a named course of single-photo worlds. Zero defines the reference; it does
not assert that WOMPar reconstructs the world perfectly.

The protocol works with meshes, splats, radiance fields, layered images and other renderable
worlds. Entrants need the same photograph and camera contract, not WOM's masks, objects, depth
model or generation pipeline. A benchmark cannot supply a universal ranking independent of
its task, photographs and judges. This protocol supplies a common, versioned way to compare them.

## The score

For each generation trial of each photograph, compare the entrant directly with the frozen
reference. Each accepted rater supplies **candidate wins**, **tie**, or **reference wins**.
Count a candidate win as 1, a genuine tie as 0.5 and a loss as 0. Let `p` be their mean, averaged
by judge, generation trial, photograph and the course's fixed stratum weights, in that order.

**Par = 100 × (1 − 2p).** Equivalently, for an equally weighted panel it is
`100 × (losses − wins) / (wins + ties + losses)`.

| Result against the same reference | Par |
| --- | ---: |
| Always preferred | −100 |
| Preferred 60% of the time, counting ties as half a win | −20 |
| Equal preference, or an exact replay of the reference | 0 |
| Preferred 40% of the time | +20 |
| Always loses | +100 |

These are **preference points**, not percentages of geometric accuracy, golf strokes, or a
ratio scale of world quality. At the ends, the scale saturates. Two entrants can tie against
the reference yet differ head to head. Keep head-to-head results as additional evidence.

Every method plays against the same anchor. Adding a competitor cannot move an existing score,
unlike refitting a joint Elo/Bradley–Terry leaderboard. Never recenter or rescale the course
when a stronger method arrives. Publish a new course alongside the old one when the reference
becomes too easy, with shared entrants to study changes; do not silently splice their scores.

## What raters judge

Use this exact question after showing the original photograph and **both complete anonymous
walkthroughs under the [capture contract](capture-v1.json)**:

> Which result better preserves this photograph as a believable, coherent 3D place to explore
> over the complete supplied route? Choose A, B, or tie when neither is meaningfully better.

Consider the photographed people's/objects' identity and appearance, scene composition,
completeness and relative placement; then whether the scene holds together as the camera moves,
with plausible depth, occlusion, shape, surfaces and surroundings. Penalize holes, floaters,
smears, duplications, billboard collapse and a good starting image that breaks under parallax.
Judge unseen surfaces for coherent plausibility. A single photograph cannot verify what those
surfaces actually looked like. Do not reward invented detail merely for being elaborate.

Make one holistic choice for the world. Do not count objects or defect boxes as votes, and do
not combine unrelated stage scores with arbitrary weights. Placement IoU, patrol Intact,
contamination, source-view image error, failure rate, cost and latency remain useful diagnostics.
They do not define the global score. The quality track permits unrestricted offline generation;
a budget-limited track must freeze its limits in a different course.

## Evidence and judging

1. Freeze photographs, categories and weights, trial/seed schedule, reference world **bytes**,
   source-camera registration, all poses/intrinsics, rendering conditions, rubric and panel
   protocol before judging a challenger. Hosted model names and Git tags alone cannot reproduce
   a stochastic output or protect against an API alias changing.
2. Keep content hashes and independent file copies. A course's canonical JSON SHA-256 binds
   all referenced hashes. World and review bundles list their child files and provenance.
   The importer checks those bytes, including nested bundles, and checks review provenance
   against the course's photograph, trajectory and conditions. An organizer must also audit
   that a submitted render actually followed the contract; hashes prove identity, not honesty.
3. Use anonymous A/B displays with a random assignment of candidate side, counterbalanced per
   comparison. Do not show method names, earlier results, claims, prices or diagnostic findings.
   The source photograph, complete ordered walkthroughs and every endpoint frame are available
   for both sides. Calibrate raters on separate examples, preregister inclusion/attention rules,
   and preserve all accepted ballots. Never discard an inconvenient vote after seeing its choice.
4. The **human track** is the durable reference track. Freeze the number of raters before the
   session: at least five distinct humans per photograph/trial. Each rater votes once per pair;
   A/B side counts differ by at most one. Record pseudonymous rater IDs and the exact evidence
   hashes. Organizer attestation is needed to establish that they were separate humans and
   followed the procedure; a JSON importer cannot certify that.
5. A **model track** is separate and provisional. Freeze at least three judge revisions and
   their prompts/settings. Every judge evaluates both A/B orders; average those two decisions
   before giving that judge equal influence. Preserve raw responses, model snapshots, prompts,
   settings and evidence hashes. The course's `evaluation.configuration` must point to a hashed
   file containing the exact evaluator prompts/settings. Changing any evaluator definition creates a different course
   digest. Model scores must not masquerade as human preference or be pooled with human votes.
   A course using a method's own model as judge needs explicit bias analysis and human checks.

A tie is an actual judgment of equivalence, not "could not inspect", "API failed" or "missing".
Missing trials, evidence, raters or model order-swaps leave the method **unranked**. Full coverage
is mandatory. A declared generation/render failure needs hashed logs; against a successful
reference it scores +100 for that trial, successful generation against reference failure scores
−100, and two failures tie. Missing ratings can never be converted into a failure penalty to
manufacture a finished evaluation. An exact identity of world and review bundles needs no
self-comparison votes and gets 0, explicitly labeled as an anchor/replay.

## Weighting and uncertainty

Freeze category weights to sum to one. Within a category every distinct source photograph has
equal weight; within that photograph every preregistered generation trial has equal weight.
Within a trial every rater has equal weight. More objects, frames, trials or ballots must not
give one photograph more influence. Exact duplicate source hashes are rejected; organizers
must also identify re-encoded copies, crops and closely related photographs and keep them
within a single sampling cluster. Never treat another saved world of the same photo as a new
independent scene. Source derivatives must not straddle development and held-out test sets.

Report point score, course hash, track, full coverage, actual ballots, unique photographs,
per-photo/per-category results and generation failures. The four-photo local pilot is a
**development convenience sample**: its scores describe that course only, and have no claimed
population confidence interval. There are no human ballots merely because a reference exists.

For a future independently sampled representative course, the implementation also provides a
conservative 95% weighted Hoeffding bound. With photo weights `w_i`, its radius in Par points is
`100 × sqrt(2 × ln(40) × sum(w_i²))`, clipped at the endpoints. This clusters the score at the
photograph, conditional on the accepted judging protocol; it does not pretend repeated frames,
generation trials or model answers are independent new photos. Effective photo count is
`1 / sum(w_i²)`. Sampling assumptions and rater/protocol bias still require an external audit.

A negative pilot/model point estimate means "preferred on this course under this panel". A
claim of a general improvement requires representative held-out scenes, suitable uncertainty
and human validation. Roster order in a table is not statistical proof of a difference.

## Files and reproduction

The reusable arithmetic and validation live in [par.ts](../../../packages/metrics/src/core/par.ts)
and the content verifier in [node/par.ts](../../../packages/metrics/src/node/par.ts). The
[Global task](../../../server/src/bench/global.ts) stores an entire course as **one** benchmark
case, so the framework cannot accidentally average only the easiest completed scenes.

```sh
npm run test:par
npm run bench:global
npm run bench:global -- --template /tmp/my-method.json
npm run bench:global -- --submissions /path/to/finished-submission.json
```

Use `--course` and `--artifacts` to select a different verified course. Submitted bundle paths
are relative to the submission's directory (or `--submission-root`). These commands import
real, already collected evidence and ballots; they make **no model calls**. They produce a
Global task run, scorecard, exact manifest/ballots and a machine-readable result in WOMetrics.
Incomplete submissions stay visible with a null score and exit status 2.

The checked-in [pilot manifest](../courses/0.1-pilot.json) names the local reference bundle
hashes. Full private source photos, worlds and review captures stay under the ignored local
data directory. A missing bundle is an error, never a request to regenerate an expensive world.
The [freeze tool](../../../scripts/freeze-par.ts) creates independent copies and captures from
a declared local [plan](../courses/0.1-pilot-plan.json); rerunning it creates a **new snapshot**,
not an identical stochastic reference. Keep and back up the original frozen bytes.

An imported submission has this shape (the template starts with an empty, unranked comparison
list; this example contains placeholders, not actual votes):

```json
{
  "protocol": "wom-par-v1",
  "courseSha256": "<canonical course SHA-256>",
  "method": { "id": "my-method", "label": "My method", "revision": "<code/models/config/seeds>" },
  "comparisons": [{
    "scene": "<course scene id>", "trial": "<frozen trial id>",
    "candidate": {
      "status": "ok",
      "artifact": { "path": "world.json", "sha256": "<hash>", "kind": "bundle" },
      "evidence": { "path": "evidence.json", "sha256": "<hash>", "kind": "bundle" }
    },
    "ballots": [{
      "judge": "<pseudonymous rater id>", "candidateSide": "A", "choice": "tie",
      "candidateEvidence": "<candidate evidence hash>", "referenceEvidence": "<reference evidence hash>"
    }]
  }]
}
```

Bundles use `{"format":"wom-par-bundle-v1","files":[{"path":"...","sha256":"..."}]}`.
Review bundles additionally record `provenance.protocol`, `status`, `sourceSha256`,
`trajectorySha256` and `conditionsSha256`. Successful review bundles record ordered
`provenance.cameraSamples: [{"id":"<trajectory sample id>","frameSha256":"<JPEG hash>"}]`
for **every** frozen camera sample and `provenance.walkthroughSha256` for the MP4. Each hash
must name a verified child file. The trajectory JSON contains `protocol`, `fovY`, `aspect` and
`samples: [{"id":"...","position":[0,0,0],"quaternion":[0,0,0,1]}]` with unique IDs.
The importer rejects missing frames or a missing walkthrough, even if a panel supplied votes.
Failed outputs also record `phase` as `generation`
or `render` and include the actual logs. Model evidence includes its evaluator prompt/settings
and raw responses. Every path is relative to the artifact root and every child is verified.

## Basis for the design

- [WorldScore](https://haoyi-duan.github.io/WorldScore/) evaluates controllability, quality and
  dynamics with explicit camera trajectories: evidence that source-view fidelity alone is
  insufficient for world generation. WOM's static pilot is a narrower task.
- [Rapidata's image-to-3D methodology](https://www.benchmark.ai/image-to-3d/methodology) uses
  a fixed image set, standardized renders and blinded pairwise human judgments. Its jointly
  fitted Bradley–Terry leaderboard serves a different purpose from this immutable par anchor.
- [HumanEval.org methodology](https://www.humaneval.org/methodology) provides a precedent for
  versioned evaluation inputs, tie handling and ranking uncertainty.
- [ITU-T P.910, July 2026](https://www.itu.int/ITU-T/recommendations/rec.aspx?lang=en&rec=16861)
  is the current subjective multimedia quality evaluation recommendation.

The signed anchor formula and the specific course contract above are WOM's design choices,
not a claim that these organizations standardized a universal single-photo world score.
