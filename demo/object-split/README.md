# Object split: interactive demo and saved parts

A self-contained page that shows how splitting a person into a head and a body, placing each part to the photo's pixels, and correcting the eyes changes one portrait: the "Beauty Counter Smile" photo (world `mvzp2tur93987dde`). The same folder holds every part the split produced.

The page opens with a 30-second animated story of the method that you can pause, scrub and play with. Every measured figure on the page and in the story (placement, sharpness, counts, costs) is read from a saved file, and the page ends with a section on what it does not claim.

## The animated hero

Six chapters, one clock: the usual way (one 3D object, smeared eyes), cutting her into parts, building each part on its own, putting every part back where the photo has it, handing the eyes back, and a before / after slider to play with. Play, pause, scrubbing, the chapter buttons and the arrow keys all go through one function, `compute(t)`, so what you scrub to is what plays.

What you can do on it: pull her head and body apart (chapter 2: drag the handle on her neck, or use its arrow keys), turn the Gaussians (chapter 3: drag), hover a ring in chapter 4 to read that feature's error, drag across her eye in chapter 5, and drag the slider and magnify with the pointer at the end. Doing any of these pauses the story. With `prefers-reduced-motion` the story starts on the slider and never plays by itself: choosing a chapter shows its last frame.

Two kinds of picture are on that stage, and the page says which is which:

- **Photo-like scenes** are Spark renders from the photo's own camera (`tools/render-frames.mjs`, turned into the web images in `assets/img/` by `tools/make-assets.mjs`), at three resolutions. A sharper one fades in only where the camera window sits inside its area.
- **The dots in chapters 3 and 4 are a sample of the real Gaussians, not a render.** `tools/make-hero.mjs` picks 96,279 of the 524,288 Gaussians in the head and body (33,828 and 62,451): for each 2.2 px cell of the photo, the opaque Gaussian nearest the camera whose size is not far bigger than the cell. `cloud.js` draws their centres and colours as discs in software, so the cloud can be turned and morphed. Each one has two real positions, where the pipeline's silhouette fit put it (from the raw PLY and `silhouette-fit-poses.json`) and where the pixel alignment moved it (from the aligned PLY). Chapter 4 slides each dot between the two. Positions are rounded to 0.1 mm. The scatter at the start of chapter 3 is seeded, so it is the same on every visit.

## Run it

```
node demo/object-split/serve.mjs [port]      # http://127.0.0.1:8790/
```

The page needs `http://` (it loads ES modules and 3D files, so `file://` will not work) and a browser with WebGL 2. There is no build step and no dependency to install: three.js and Spark are vendored under `vendor/`.

## What a visitor downloads

| | size |
|---|---|
| First load, before scrolling | 2.5 MB in 35 requests (no 3D files). That includes the story's first scene: six pictures, 1.4 MB |
| The rest of the story, fetched as it plays | The 1.5 MB Gaussian sample from about 3 s in, and each later chapter's pictures once the chapter before is 40% through. With the whole story loaded the page has fetched 5.2 MB in 57 requests |
| The 3D viewer, started when its section comes within 700 px of the screen | +21.4 MB: 15.5 MB of SPZ files, 5.0 MB of three.js and Spark, about 1 MB of other files (measured by jumping straight to the viewer) |

Before the hero was animated the first load was 2.1 MB in 28 requests; the story adds 0.4 MB and 7 requests up front. All three figures come from `.scratch/idol-split/demo/test-lazy.mjs` (response bodies plus headers; the folder's scratch tests are not saved in the repo). If a chapter's pictures have not arrived when the story gets there, the story holds and shows a spinner. The story and the viewer both stop drawing when they are idle or off screen.

## Hosting it

Upload the folder to any static host. The folder as made is 138 files, 138.4 MB. **The git repository holds 132 of them, 30.9 MB: the six full-quality PLY files in `parts/splats/ply/` (107.5 MB) are left out** (`.gitignore` names them), to keep the repository light. The Parts section then lists those six files by name, with a note, instead of download links, and nothing else on the page depends on them. To host the page with the downloads, copy the six files back into `parts/splats/ply/` first; `parts/manifest.json` has the size and SHA-256 of each, so a copy can be checked.

## Folder map

```
index.html, demo.css, demo.js    the page (plain ES modules)
hero.js, hero.css                the animated story at the top of the page
cloud.js                         the small software renderer for the sample of Gaussians (runs in the page and in Node)
viewer.js                        the live 3D viewer (loaded only when you scroll near it)
serve.mjs                        a small static server with no dependencies, for local use
assets/
  data.json                      every figure the page shows, built by tools/make-assets.mjs
  img/                           web images: renders, eye windows, cutouts, masks, thumbnails
  hero/                          the story's own files: the Gaussian sample (cloud.json, cloud.bin), the photo cut into head and body, outlines of each part
  splats/                        the four SPZ files the viewer loads
vendor/                          three.js and Spark (MIT; licences included)
parts/                           the saved parts (below)
tools/                           the scripts that built the above
```

## The saved parts

`parts/manifest.json` lists all 37 files with size, SHA-256, what each is, and where it came from. In short:

| folder | contents |
|---|---|
| `photo/` | the original photo |
| `sam-parts/` | the nine SAM 3.1 part masks (hair, face, neck, ear, headband, hand, dress, both arms) |
| `split/` | head and body masks, the overlap band, the jaw patch, and the two cutouts the 3D model received |
| `one-object/` | the whole-figure mask and cutout (the original pipeline's input) |
| `splats/ply/` | the 3D parts at full quality: the whole figure, head and body as the 3D model returned them, head and body after alignment, and the head with the eye corrector. **Not in git** (6 files, 107.5 MB): see "Hosting it" |
| `placement/` | poses (`layout.json`, `fit-result.json`, `silhouette-fit-poses.json`), the scene, and the raw measurements |
| `cost/` | the ledger lines behind every dollar figure |
| `tests/` | the comparison picture from the 1,048,576-Gaussian test |

To reuse a part: the PLY files are in the 3D model's own frame. Apply the pose in `placement/layout.json` (position, quaternion `[x y z w]`, uniform scale) to put it where the photo has it, in a scene with the camera at the origin looking down -Z.

The same parts are installed in the app as world `mw16xplr29532e14` (objects `woman-head` and `woman-body`). The original world and its flagged observation were not changed.

## Where the numbers come from

- **Gaussian counts**: the PLY headers, read by `tools/build-parts.mjs`.
- **Costs**: `data/ledger.jsonl`. `build-parts` copies the relevant lines to `parts/cost/ledger-entries.json` and fails if a job is missing.
- **Eye placement, sharpness and detail**: `tools/eye-metrics.mjs`, run on the Spark renders in `.scratch/idol-split/demo/frames/`. Placement and detail are measured separately: each eye is first slid onto the photo's, then compared.
- **Feature placement** (the Placement table): `parts/placement/measurements/`.
- **Eye corrector figures** (Gaussians added and refitted, see-through before and after): its own log, saved as `parts/placement/measurements/eye-corrector.txt`, cross-checked against the PLY headers. The "outside the eyes" figure (no pixel changes by more than 1 in 255) is measured over the whole frame between the renders with and without the corrector.
- **The story's cards**: the same `data.json` as the rest of the page, read when the page loads. The measured limit outside the eyes (no pixel changes by more than 1 in 255, over 1,563,386 pixels outside a 10 px feather) is `eyeCorrector.outside`.
- **How far the alignment moved the Gaussians**: `tools/displacement.mjs`, from the raw and aligned PLY files.
- **What the SPZ conversion changes**: SPZ is lossy. `tools/spz-fidelity.mjs` compares Spark renders of the PLY parts with renders of the SPZ files from three cameras and saves the result as `parts/placement/measurements/spz-fidelity.txt` and `.json`. At the photo's camera a render differs by 0.26 in 255 on average (0.91 inside the eyes), and the worst pixel by 50. The renders it compares were made with a scratch script (`.scratch/idol-split/render-parts.mjs`) that is not in the repo, so this one measurement can be read but not re-run from the repo alone.

## Rebuilding

The parts were made on one machine, and two of the steps read files that are not in git (`data/` and `.scratch/` are both ignored). `parts/` is the durable copy; treat step 1 as a record of how it was assembled. Steps 2, 4 and 5 need only `parts/` (step 4 also needs the frames from step 3, and step 5 the `data.json` from step 4). Step 3 draws the portrait over the world's backdrop, so it needs the world folders under `data/`.

The six PLY files in `parts/splats/ply/` are also not in git (see "Hosting it"). Steps 2, 3, 4 and 5 read them, so copy them back from the machine that made them before running any of those. Without them the page itself still works from the committed `assets/`.

| step | command | reads | writes |
|---|---|---|---|
| 1 | `node demo/object-split/tools/build-parts.mjs` | the two world folders, `data/ledger.jsonl`, `.scratch/idol-split/`, `.scratch/idol-1m/` | `parts/`, `assets/img/masks/` |
| 2 | `node demo/object-split/tools/make-splats.mjs` | `parts/splats/ply/` | `assets/splats/*.spz` |
| 3 | `node demo/object-split/tools/render-frames.mjs` | `parts/`; under `data/`: both world folders (scene and backdrop splats) and the flagged observation's camera | `.scratch/idol-split/demo/frames/` |
| 4 | `node demo/object-split/tools/make-assets.mjs` | `parts/`, the frames from step 3 | `assets/img/`, `assets/data.json`, `vendor/` |
| 5 | `node demo/object-split/tools/make-hero.mjs` | `parts/`, `assets/data.json` | `assets/hero/` |

Run from the repo root, with `npm install` done (steps 1, 3 and 4 use `sharp`; steps 2 to 4 use `three` and Spark from `node_modules`).

Steps 2 and 3 run Spark in headless Chromium and need `playwright-core`. If it is not installed in this repo, point `PLAYWRIGHT_CORE` at any copy:

```
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.mjs node demo/object-split/tools/make-splats.mjs
```

`render-frames.mjs --check` renders one frame at the flagged camera and compares it with a frame captured in the real app (`.scratch/idol-split/renders/app-eyes.png`, not saved in `parts/`). It measured a mean difference of 0.08 in 255. Steps 2, 4 and 5 are repeatable: rebuilding left the SPZ files byte-identical, `data.json` unchanged apart from its timestamp, and all 18 files in `assets/hero/` byte-identical (the rebuild takes under a second). `make-hero.mjs --cloud-only` rebuilds just the Gaussian sample; the sampling cell is `CELL` (default 2.2).

## What it does not claim

The page's last section says this in full. In short:

- It is one photo, and the parts on this page were made by scripts. The pipeline now splits, aligns and corrects a person by itself (see "Splitting people" in the repository's README), in a slightly different way: no separate pose fit, and brows, lips and nose corrected as well as the eyes. This page shows the scripted run.
- In the story, the dots are a sample (about 18% of the Gaussians), drawn as plain discs. They show where the Gaussians are and how they moved, not what the renderer makes of them.
- From the side, a thin see-through wedge can open between the hand and the neck. Nothing shows near the photo's view.
- The eye corrector is painted from the photo's camera. It is a fix for views near the photo's, and it does not invent detail the photo never had.
- To match the photo, Gaussians were moved sideways in its view (4.4 mm in the head and 5.0 mm in the body at the median, 16.5 mm at the farthest). Depth is untouched, so the head is slightly bent in 3D.

## Licences

three.js and Spark are MIT licensed; their licences are in `vendor/three/LICENSE` and `vendor/spark/LICENSE`. The photo and the 3D parts built from it belong to the World of a Memory project.
