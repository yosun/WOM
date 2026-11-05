# WOM technical infographic: evidence and reproduction

The [README infographic](../wom-technical-overview.png) uses actual saved outputs from the public [Sunny Garden world](https://wom.quest/u/yosun/mvxixlbz34cbfb22). The [editable SVG](../wom-technical-overview.svg) embeds the selected images; the [provenance manifest](provenance.json) pins input and output SHA-256 hashes, transformations, model identities, camera poses, and selected repair evidence.

The original source contains a **golden retriever**. All reconstruction panels use that source and its retained outputs. The bicycle repair is a separate recorded regression run using the same source world. Its before/after pair uses identical camera parameters.

| Panel | Actual evidence | Meaning and limits |
| --- | --- | --- |
| [Source](source.jpg) | Original 1920 × 1280 photo, downsampled for publication | The real input to this reconstruction |
| [Segmentation](masks.jpg) | Four saved SAM 3.1 binary masks over the source | Colors and boundary highlights visualize existing masks; no new mask geometry |
| [Raw cutout](cutout-raw.png) / [completed input](cutout-completed.png) | Bench pixels before and after Muse Image completion | The completed input has an existing white RGB background, preserved as recorded |
| [Clean plate](clean-plate.jpg) | Saved Muse Image output with selected foreground objects erased | Input for rebuilding the surrounding world |
| [Depth](depth.png) | Saved MoGe-3 scalar depth on a 1024 × 683 grid | Predicted metric depth, not measured ground truth; logarithmic display clipped to the 2nd–98th percentiles, approximately 2.025–23.047 m; gold nearer, blue farther |
| [Mesh](mesh.png) | Retained Tripo H3.1 preview of the bench's GLB | An alternative textured mesh asset |
| [Gaussian object](gaussian.jpg) | Retained TripoSplat preview of the bench's PLY | This preview is **TripoSplat**, not IDOL; the application also supports IDOL |
| [World](world.jpg) | Retained World Labs Marble thumbnail | Generated surroundings; not a new render or generation |
| [Placement overlay](fit-overlay.jpg) | Both saved Tripo H3.1 / MoGe-3 bench fits | Magenta is the SAM target and cyan the rendered silhouette. Rounded silhouette IoU is 0.80 for `fitter` and 0.82 for `fitter-grounded`. These are one object's diagnostics, not a global score |
| [Source-camera render](source-view.jpg) / [novel camera](novel-view.jpg) | Frozen course frames `0000` and `0009` | Source and right patrol cameras from the same saved reconstruction; camera parameters are in the manifest. The separately quoted 58.8° HFOV and 15,772 samples describe Marble/background calibration |
| [Before](repair-before.jpg) / [after](repair-after.jpg) | Hash-verified retained frames for `repair-002` in run `amw2v11ff2583cc4f` | Same camera. The accepted test replaced the IDOL bicycle with an existing Tripo H3.1 asset after reviewing all 15 required views |

The repair replay recorded nine fixed sightings and 32 remaining open issues. The run ended at its budget limit; a prior cleanup candidate was rolled back. It made zero new 3D generation jobs. This is a local defect repair, not proof of complete-world quality or a Global WOMPar result. [Open the public recorded replay](https://wom.quest/u/yosun/mvxixlbz34cbfb22/agents).

## Rebuild the infographic from a public checkout

```sh
npm ci
node scripts/build-readme-technical.mjs
```

Run from the repository root. The renderer reads these checked-in images, verifies their hashes, and writes the SVG and PNG. It uses the project's existing Playwright support and a local Chrome/Chromium installation. It makes no network or model requests.

To re-export the selected images from the original local demo cache, use `node scripts/prepare-readme-technical-assets.mjs`. That optional step requires the local files named in the provenance manifest; the public checkout does not contain the full original worlds or raw repair records. The exporter strips EXIF/IPTC/XMP and publishes only the explicit image allowlist and selected numerical evidence. Raw provider receipts, signed download URLs and credentials are excluded.
