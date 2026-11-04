# World of a Memory (WOM)

WOM turns one photo into an explorable 3D world. The viewer opens on the original photo while the world loads behind it, framed by the camera WOM reconstructed. The keyhole of the WOM logo sits on the photo, small and sparkling. Tap it and it grows: dark inside, with a lit amber outline, while the world loads, then lit and open onto the live 3D scene once it is ready. Press *Enter the world* and the keyhole grows about its head, like an iris, past the photo's borders until the 3D scene fills the screen, which you walk through with W A S D. Worlds are chosen from a stack of slides (`#/space`), and a slide flies into the viewer without a jump; see [Slides](#slides-choosing-a-world-and-how-to-enter-it).

WOM is also **World Observation Metrics**: the measurements of how faithfully a rebuilt world matches the photo it came from. They have a page of their own at `#/bench`; see [WOM: World Observation Metrics](#wom-world-observation-metrics).

WOM runs at https://wom.quest. Where things are written down:

| Document | Covers |
| --- | --- |
| This file | The pipeline, the viewer, accounts and credits, the benchmark, the file layout |
| [`packages/metrics/README.md`](packages/metrics/README.md) | `@wom/metrics`, the benchmark framework and its page |
| [`demo/object-split/README.md`](demo/object-split/README.md) | A static demo page of the head/body split, with every part it produced |

## How a photo becomes a world

| Step | Model | What it does |
| --- | --- | --- |
| Scene plan | **Muse Spark 1.3** (or Muse Wonder 1.0) | Reads the photo and picks the objects to rebuild as separate 3D objects. For each object it returns a box, a point inside it and a short description. It also writes the object-removal instruction and the prompt for the surrounding world. |
| Segmentation | **SAM 3.1** (Meta Model API) + Muse Spark review | Runs a box+point prompt and a concept prompt for every object. Concept prompts capture foliage and spokes; box prompts handle solid objects. When both give plausible masks, Muse Spark rates the cutouts and the cleaner one wins. |
| Head/body split | **SAM 3.1** | For each person the plan marks, finds the face, neck, hands, clothing and arms and replaces the person with a head and a body that overlap across the neck. See [Splitting people](#splitting-people-into-a-head-and-a-body). |
| Clean plate | **Muse Image** + Muse Spark review | Erases the chosen objects and their shadows. Muse Spark checks the edit and asks for another pass if anything is left. |
| Depth | **MoGe-3** on AI3D (`moge3`, default; MoGe-2 is `moge2`) | Produces a metric point map of the photo (for placing objects) and of the clean plate (for the background relief). |
| Cutouts | SAM masks + **Muse Image** | Cuts each object out with its mask. Objects that are occluded or cut off by the frame are completed by Muse Image. |
| Objects | **IDOL** on AI3D (`idol`, default) | Turns each cutout into a Gaussian-splat object (PLY, 262k splats). Splats keep the photo's look, including fur and leaves. TripoSplat (`triposplat`) splats and textured meshes from Tripo H3.1 (`tripo-v31`) or Tripo P1 (`tripo-p1`) are available under *Settings*. |
| Surrounding world | **World Labs Marble 1.1** on AI3D | Generates a Gaussian-splat world from the clean plate plus Muse Spark's world prompt. |
| Compose | Local (Node) | Calibrates Marble's camera against the photo, fits each object into place, builds the depth relief, and writes `scene.json`. A split person's head and body are then aligned to the photo's pixels. |
| Placements | Local + **Muse Spark 1.3** and **Muse Wonder 1.0** agents | Computes the other placements the viewer can switch to: the fitter kept upright on the ground, and each model's agent placement (the same agent as in the placement benchmark). |

### Placement ("compose")

- **Gravity.** A plane is fitted (RANSAC, then least squares) through ground pixels of the MoGe depth, in the camera the scene is composed in. It gives the "up" direction the viewer walks along and the camera height. Averaging MoGe's normals instead had put the backyard camera 14° down; the plane says it is level, which Marble's own gravity-levelled frame confirms.
- **Marble calibration.** Marble keeps the input camera at the origin of its raw OpenCV-style frame but uses its own field of view and units. WOM renders the splats from the origin and searches field of view, pitch, yaw and roll until they match the clean plate. Metric scale is the median ratio of MoGe depth to splat depth.
- **Object fitting.** A CPU rasterizer renders each object and fits scale, image position, yaw and pitch so its silhouette matches the SAM mask. Pixels hidden by something closer in the MoGe depth map are not penalized, and neither are parts beyond the image border. Finally the object slides along the camera ray until its visible surface matches MoGe's metric depth. Moving along the ray cannot change the silhouette, so this step keeps the fit.
  - Tripo meshes start facing the camera along their viewing ray, which is what `align_image` produces.
  - IDOL and TripoSplat objects come out with −Y up but with no fixed facing (IDOL's dog faces +X, its bench −Z), so the fitter searches the full circle of yaw. Splats are drawn as discs 1.5× the geometric mean of their two largest axes. That size reproduces Spark's on-screen silhouette at IoU 0.92–0.98; larger discs made every object come out 5–14% too small.
- **Check.** Compose writes `reprojection.jpg`, the reconstruction rendered from the photo's camera, so you can compare it with the photo.

### Placement choices

After compose, the *Placements* step stores up to four placements per object in `scene.json` (`objects[].placements`), each with its silhouette IoU, ground gap and tilt:

| Method | How the object is placed |
| --- | --- |
| `fitter` (default) | The compose fit above. |
| `grounded` | The fitter kept upright along gravity, then scaled about the camera so its base pivot rests on the ground plane. Scaling about the camera keeps the silhouette, so the object stops floating or sinking; its size then comes from the ground plane instead of the depth of its surface. |
| `agent-spark` | Muse Spark 1.3 as an agent with the benchmark's tools (render and score a placement, run the fitter, read MoGe depth), then submitting a placement. |
| `agent-wonder` | The same with Muse Wonder 1.0. |

Which agents run is chosen per world. New worlds take it from *Settings → Placement agents* on the home page (`placementAgents`, both by default). In the viewer, *Layers → Placement → Placement agents* changes it for that world. A chosen agent that has not placed the current objects can be run there and then, with the estimated cost shown. Chosen agents also run whenever the world's objects are rebuilt (`POST /api/worlds/<id>/agents` with `{"agents": [...], "run": true}` does the same). Agent calls go through the benchmark's call cache, so a world whose objects were already benchmarked gets the agent placements for free, and recomposing or switching the object model only reuses cached answers. A world build spends at most $3 on agents. A changed mask shifts the ground plane slightly, which changes the agents' inputs, so after a mask is redone every object's agents run again.

The viewer lists every method with its mean IoU under *Layers → Placement*. *Use for this world* saves the selected one as `manifest.placementMethod` (`POST /api/worlds/<id>/placement` with `{"method": "grounded"}` does the same), and the world opens with it from then on.

On the benchmarked objects the agents almost always ran the fitter and submitted its result, so their placements usually equal `grounded`. They differed where the agent overruled the fitter, as on the courtyard wellhead while its first mask was on the wrong object.

### Fixing an object's mask

When SAM outlines the wrong thing (the courtyard wellhead's first mask was a fern in front of it), the build page's *Fix mask* button on that object opens an editor:

- Click the object to add points, Alt-click or right-click what is not the object, or drag a box around it.
- *Preview mask* runs SAM 3.1 on those marks ($0.0025) and shows the result without changing the world.
- *Keep this mask* rebuilds that object only: its cutout (plus the Muse Image completion if it is hidden, $0.01), its asset for the world's object model ($0.10 with IDOL), compose, and the placements. The plan, clean plate, depth, Marble world and the other objects are reused.

The replaced mask, its cutout and every asset made from it move to the object's `history` and stay on disk. *Restore mask v1* (in the same editor) brings them back for free. Version *n* of an object keeps its files in `objects/<id>/m<n>/`, and its AI3D job names end in `-m<n>`, so nothing from an earlier mask is overwritten or reused for a new one. The API is `POST /api/worlds/<id>/objects/<object>/mask/preview` with `{"points": [{"x", "y", "positive"}], "box"}` in photo pixels, then `POST …/mask` to keep the draft, or `POST …/mask/restore` with `{"version": 1}`.

The clean plate is made from the objects' names, not their masks, so fixing a mask does not change it.

### Splitting people into a head and a body

A 3D model of a whole person gets the face only a few dozen pixels wide, so eyes, brows and lips come out smeared. Built from the head alone, the face fills the model's input. With *Settings → Build a big face as its own head and body* (`splitPeople`, on for new worlds), WOM does this for a person whose face is large in the photo:

- **Plan.** Muse Spark marks a person for the split when the head is at least 14% of the image's height or 10% of its width, the face is turned toward the camera, and the head and torso are both in the frame, and it draws a box around the head. With the option off, the request is the same as before, word for word.
- **Split** (a step after segmentation). SAM 3.1 concept prompts find the person's face, neck, hands, clothing and arms, and the regions the detail corrector works on (eyes, eyebrows, lips, nose): nine requests, $0.0225. The cut runs 55% of the way down from the chin to the bottom of the neck, and the parts overlap by 0.8% of the photo's long side on each side of it. Where a hand covers the jaw, the jaw is painted in from the skin around it. The person becomes two objects, `<id>-head` and `<id>-body`. If SAM finds no face in the head box or no neck, the head is not above the body, or a part comes out too small, the person stays one object and the log says why. If SAM does not answer, the step fails, and a retry splits the person and builds both parts.
- **Cutouts and 3D.** The head is cut from the photo with the jaw painted in. Each part is its own IDOL job, and neither is sent to Muse Image for completion.
- **Compose** fits each part's silhouette as usual, then aligns the pair to the photo's pixels in a worker thread:
  1. *Warp.* Three passes measure where each part's render is off the photo's (block matching at three scales, plus snapping the outlines and the neck seam onto the masks) and move every Gaussian sideways in the photo's view. Depth and the poses stay as the fitter left them.
  2. *Seam fill.* From 20 cameras around the person, gaps that open between the head and the body are closed with small patches. A patch is kept only if the photo's camera cannot see it.
  3. *Detail corrector.* Over the eyes, brows, lips and nose, a layer of new Gaussians at photo resolution and a least-squares fit of the colours make the head reproduce the photo. The correction fades out over 10 px around each region.

  The result is written next to IDOL's file as `objects/<id>/model-aligned.ply`, and the manifest records it with a hash of every input (`objects[].aligned`). On the photo below the first compose took 73 s instead of 7 s; later ones reuse the result unless an input changed. A stage that fails is left out with a note in the log. If alignment fails, the parts are shown as fitted.
- **Placements.** The head and the body keep the fitter's placement only: placing them separately would pull them apart.

Only Gaussian-splat object models (IDOL, TripoSplat) are split, because alignment moves Gaussians. Worlds made before the option existed are not changed: their plan has no head boxes, so a retry keeps their people whole.

On the *Beauty Counter Smile* photo, the pipeline's own output (`scene.json`), against the same woman built as one object:

| At the photo's camera | One object | Split, silhouette fit only | Split, now |
| --- | --- | --- | --- |
| Colour error over her (of 255) | 23.7 | 24.9 | 16.4 |
| Worst of ten facial and clothing features, off the photo's | 42.6 px | 33.9 px | 0.9 px |
| Median of those features | 27.5 px | 15.4 px | 0.2 px |

The detail corrector, per region at 2× (a pixel-ratio-2 screen): colour error 29.2 → 2.1 and sharpness 39% → 68% of the photo's for the eyes, 24.7 → 1.8 and 41% → 61% for the brows, 18.9 → 1.4 and 62% → 69% for the lips, 15.8 → 1.4 and 26% → 58% for the nose. More than 10 px outside the regions, no pixel changes by more than 2.4/255.

What it does not fix: from the side the split still shows more see-through pixels inside her outline than one object, 11,916 against 8,674 over nine views round her (640×512 each), down from 15,021 for the split as the fitter left it. Some of what is left lies between the hair and the shoulders, where the photo's camera sees the background, so a patch there would change the photo's view; the rest is holes inside the body model itself. The feature has been tested end to end on this one photo.

## What you can upload

| Upload | How WOM reads it | What is kept with the world |
| --- | --- | --- |
| JPEG, PNG, WebP, AVIF | sharp | The photo (turned upright, at most 2048 px) and its lens data |
| HEIC / HEIF (iPhone photos) | macOS ImageIO (`server/tools/imageio-extract.swift`) on a Mac, libheif (`server/tools/libheif-extract.py`) on any other server | Also the original file, every frame the file holds, and the depth or disparity map and portrait/sky/hair/skin mattes Apple stores with Portrait and LiDAR photos |
| MOV / MP4 (for example a Live Photo's `.MOV`) | ffmpeg | Also the original file and eight frames spread over the clip |

When a file holds more than one frame, the home page shows them and you pick the one to build from; all of them stay in `source/`. An iPhone photo normally holds one frame plus that depth map and the mattes. Live Photo motion lives in a separate `.MOV`, which can be uploaded on its own. On a Mac the ImageIO reader is compiled once, on the first HEIC upload, into `data/tools/` (it needs Xcode's command line tools). On Linux and other servers HEIC is read by libheif through Python: `pip install pillow-heif` (the wheel bundles libheif and the libde265 HEVC decoder) and, if that Python is not `python3` on the `PATH`, set `WOM_HEIC_PYTHON` to it. Both readers return the same things: the frames, the depth or disparity map with the camera's accuracy and quality flags, and the mattes. `WOM_HEIC_DECODER=imageio|libheif` overrides the choice, for example to run libheif on a Mac. libheif checks that the file is complete, because an upload cut short would otherwise decode as a mostly wrong picture. Videos need `ffmpeg` and `ffprobe`.

**Lens data.** The camera, lens and 35 mm-equivalent focal length are read from EXIF (or from a Live Photo video's QuickTime metadata) and saved as `manifest.image.camera`. The focal length gives the photo's real horizontal field of view, matched on the diagonal as camera makers do; a camera that matches the width instead would read about 2° wider. Each depth model's field of view (`hfovDeg` on its depth maps) is compared with it on the build page (*Camera*) and, across all worlds, on the Camera tab of [WOM: World Observation Metrics](#wom-world-observation-metrics). When the photo carries the phone's depth or disparity map, both MoGe models are also compared with it after the best scale (and shift, for disparity), along with their correlation. LiDAR depth is metric, so for those photos the comparison also shows how far off MoGe's metric scale is. `GET /api/worlds/<id>/camera` and `GET /api/cameras` return the same numbers; `POST /api/inspect` returns what a file holds without making a world.

## Run it

Requirements: Node 22.18+ (Node runs the TypeScript server directly) and API keys for the Meta Model API and AI3D. Optional: for HEIC uploads, Xcode's command line tools on macOS or Python 3 with `pillow-heif` anywhere else; `ffmpeg` for video uploads.

```bash
cp .env.example .env     # then fill in MUSE_API_KEY and AI3D_API_KEY
npm install
npm run dev              # API on :8787, web app on http://localhost:5173
```

On your own machine that is all it takes. The server listens on 127.0.0.1, sign-in is off, the one person at the machine is an administrator, and worlds are folders under `data/worlds/`. A server other people can reach also needs Clerk for sign-in and, to share worlds and sell credits, Postgres: see [Accounts, sharing and credits](#accounts-sharing-and-credits). `.env.example` lists every variable.

`.env` holds the server's keys. `.env.local` holds keys that only the patrol's judges need (`OPENAI_KEY`, `GEMINI_API_KEY`); `npm run bench:patrol` reads both files. Neither is committed: see [Secrets and local files](#secrets-and-local-files).

For a single-process build: `npm start`, then open http://127.0.0.1:8787. `npm run typecheck` checks the server, the web app and `@wom/metrics`.

`node --env-file=.env scripts/make-sample.ts samples/backyard.png` generates a sample photo with Muse Image ($0.01).

## Cost per world

A 4-object outdoor photo with the default settings costs about **$2.60**:

- Muse Spark plan, SAM 3.1, clean plate, review and one completion: $0.06
- MoGe-3 ×2 (photo and clean plate): $0.20
- IDOL ×4: $0.40
- Marble 1.1: $1.26
- Placement agents: about $0.07 per object for Muse Spark and $0.10 for Muse Wonder (means over 19 benchmarked objects each), so about $0.68
- Asset check: $0.009 per object, so about $0.04 (see [Asset check](#asset-check))

The unit prices are measured charges. Objects cost $0.10 each with IDOL, $0.05 with TripoSplat, $0.30 with Tripo H3.1 (`tripo-v31`) and $0.50 with Tripo P1. MoGe-2 costs the same as MoGe-3. Turning both placement agents off brings the same world down to about $1.92. Without a Marble world, a 2-object portrait costs $0.36 with TripoSplat objects and no agents. Marble draft (`worldlabs-draft`) costs about $0.18 instead of $1.26. Every charge is listed on the world's build page. A person split into a head and a body adds $0.12: one more IDOL job ($0.10) and nine SAM 3.1 requests ($0.0225).

Finished steps are never re-run: retrying a world reuses paid outputs and resumes AI3D jobs that were already submitted.

### Every 3D model is generated once

Each object keeps the output of every model it was ever generated with for its current mask, in `manifest.objects[].assets` (one entry per model: file, preview, AI3D job, cost, and the SHA-256 of the cutout it came from); assets made from earlier masks stay in `history`. Surrounding worlds are kept the same way per Marble model in `manifest.worldAssets`, and depth maps per MoGe model in `manifest.depthAssets`. New outputs go to `objects/<id>/<model>/` (`objects/<id>/m<n>/<model>/` after a mask redo), `world/<model>/` and `depth/moge3/`, so models never overwrite each other.

The build page's *Object models* panel lists, per model, how many objects have it:

- *Generate* makes it for the objects that lack it, without changing what the world shows (`POST /api/worlds/<id>/assets` with `{"model": "tripo-p1"}`), so models can be compared in the benchmark first.
- *Show in the world* switches every object to a model they all have (`POST /api/worlds/<id>/object-model`). It costs nothing: no 3D job runs, and agent placements come only from the cache.

Retrying with another model (`POST /api/worlds/<id>/retry` with `{"meshModel": "tripo-v31"}` or `{"depthModel": "moge2"}`) also reuses what exists and generates only what is missing, once. Worlds built before the registry existed are migrated at server start: the active asset is registered, and older files (for example a `model.glb` from an earlier Tripo run) are matched to the job that made them by reading the world's log.

Every paid call, from world builds and from benchmarks, is also appended to `data/ledger.jsonl`. At first start the ledger is filled from the costs already recorded in each world.

## Accounts, sharing and credits

None of this is needed on your own machine. It matters on a server other people can reach, such as wom.quest.

| | Your machine (the default) | A server |
| --- | --- | --- |
| Sign-in | Off. `HOST` is `127.0.0.1`, and the one person at the machine is an administrator. | Required whenever `HOST` reaches beyond the machine. Set `WOM_AUTH=required` on production, so a reverse proxy cannot leave it off. It needs `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`; without them every request that needs a person answers 503. The server refuses to start with `WOM_AUTH=off` unless `HOST` is loopback. |
| Storage | `WOM_STORE=fs`: worlds are folders under `data/worlds/`. | `WOM_STORE=postgres`: owners, handles, visibility and credits are rows in Postgres (Neon). A world's files stay on the server's disk. Without it, a server that requires sign-in shares nothing and anyone signed in can reach every world. |

### Postgres

The schema is `db/migrations/001_init.sql`, one transaction. Three roles touch it:

| Role | Used by | Can |
| --- | --- | --- |
| `wom_owner` | You, to apply migrations. Never deployed. | Everything. |
| `wom_app` | The API and the build worker (`DATABASE_URL`). Row-level security applies. | Read and write its own caller's rows, spend that caller's credits, redeem a promo code. It cannot grant credits, change roles or read other people's rows. |
| `wom_system` | The Stripe webhook, promo minting and admin tools (`DATABASE_URL_SYSTEM`). | Full access. |

To set up a database: put the owner's connection string in `.env` as `DATABASE_URL_ADMIN`, apply the migration (for example `psql "$DATABASE_URL_ADMIN" -f db/migrations/001_init.sql`), then run `node scripts/db-roles.mjs`. It gives `wom_app` and `wom_system` random passwords and appends `DATABASE_URL` and `DATABASE_URL_SYSTEM` to `.env`, so no password is ever in git. Only the admin scripts read `DATABASE_URL_ADMIN`; the server never does. `WOM_STORE=postgres` needs both of the other two URLs.

The API tells the database who is asking once per transaction (`app.user_id`, `app.role`), and the policies do the rest. `access.ts` writes the same world-read rule again in code (`levelOf`, mirroring the `worlds_read` policy), so a bug in one cannot show more than the other would.

### People and links

A signed-in person is a row in `users`, made the first time they are seen. Their **handle** names them in links: `https://wom.quest/u/<handle>/<world>` opens a world and `/u/<handle>/<world>/build` its build page. A handle is 3 to 30 lowercase letters, digits or hyphens, starting and ending with a letter or digit, and not on the reserved list (`admin`, `api`, `billing` and similar). A new person gets their Clerk username if it is free, then that name with three random characters added, and otherwise `user-` and six random characters. They can change it on the home page. Links made with the old name keep working, because a world is found by its id and the server redirects to the current handle. Old `#/world/<id>` addresses are redirected to the path form.

Make someone an administrator, who builds free and sees every world and the benchmark, observation and spend tools, with `node scripts/db-admin.mjs <handle>` (`--revoke` takes it away, `--env .env.main` targets production). They must have signed in once.

### Who can see a world

A world is `link` (the default: anyone with the link can look, with no sign-in) or `private` (its owner and administrators only). The owner switches it with the *Open by link* button inside the world (`PUT /api/worlds/<id>/visibility`). A world can also be taken down in the database (`worlds.removed_at`), which hides it from everyone but its owner and administrators.

Someone who only looks gets what the viewer draws and nothing else. By path allow-list, that is `scene.json`, `relief.glb`, `source.jpg`, `thumb.jpg`, `clean.jpg`, `reprojection.jpg`, the Marble world's splats and collider, each object's `model*` and `preview*` files and its cutout, and the slide images. The manifest they receive is trimmed (`publicManifest`): no costs, vendor job ids, errors, uploaded file name, depth maps, masks or per-object details.

### Who may do what

`access.ts` holds every `/api`, `/files` and `/bench-files` route to a rule, and a route with no rule is for administrators only.

| Need | Routes |
| --- | --- |
| Nobody | `GET /api/health`, `/api/auth/config`, `/api/me`, and `POST /api/stripe/webhook` (Stripe's signature is the proof) |
| Signed in | Make a world (`POST /api/worlds`, `/api/inspect`), list your worlds and slides, change your handle, read your credits, redeem a promo code |
| Look | A shared world's manifest, scene, slides and public files |
| Flag | A signed-in visitor may flag a problem in a shared world |
| Owner (or administrator) | Everything else about one world: retry, layout, slides, visibility, placement, observations, delete |
| Administrator | Tools that spend model budget and are not priced in credits yet: extra object models, asset checks, placement agents, mask redo, paid fixes, minting promo codes (`POST /api/admin/promo`) |

### Credits

With `WOM_STORE=postgres`, building a world costs a person who is not an administrator `WOM_WORLD_CREDITS` credits (500 by default). An administrator, and a server with no database, build for free.

- The credits are taken when the upload is accepted, before anything that costs money starts, and keyed by the world, so two uploads at once cannot spend the same credits. A balance that is too low answers 402 with the balance and the price. A retry of a failed world does not charge again.
- **Not refunded automatically.** If a build fails, or a world is deleted, the credits stay spent. `wom.credit_release` and `releaseForWorld` (`server/src/credits.ts`) exist for giving them back, but nothing calls them yet.
- **Promo codes** look like `WOM-ABCD-EF23`, are redeemed once per person on the home page, and only their hash is stored. Make them with `npm run promo -- --credits 1500 --count 25 --days 45 --note judges`. On production, run `node --env-file=.env.main scripts/promo.ts` with the same options. The codes are printed once and nowhere else. A person gets 8 tries per 10 minutes.
- **Packs** are bought through Stripe Payment Links, listed in `server/src/packs.json` (four packs, $10 to $100, test mode today). The server holds no Stripe API key. It sends the buyer to the link with their user id attached, and Stripe tells it who paid through a signed webhook. The only secret is that endpoint's signing secret, `STRIPE_WEBHOOK_SECRET`, and packs are offered only while it is set. Credits are added once per checkout, a payment of the wrong amount answers 500 so Stripe retries, and a test event never adds credits on a live site. `node scripts/stripe-packs.mjs` makes the packs (test mode only, through the Stripe CLI you are logged in with). The webhook is an endpoint for `checkout.session.completed` and `checkout.session.async_payment_succeeded` at `/api/stripe/webhook`; put its signing secret in `STRIPE_WEBHOOK_SECRET`. Locally, `stripe listen --forward-to localhost:8787/api/stripe/webhook` prints one.

### Link previews and search

A link to a shared world unfurls in a chat with the memory's title, a line from its plan and its photo cropped to 1200×630 (`/u/:handle/:id` and `/og/:id.jpg`, `server/src/share.ts`). Every `/u/` page is `noindex`. A world nobody may look at, or none at all, shows the site's own tags and tells nothing about the world. The home page is indexable: `web/index.html` carries its Open Graph, Twitter and JSON-LD tags, and `web/public/` holds `robots.txt` (which keeps `/api/`, `/files/` and `/bench-files/` out), `sitemap.xml`, the favicons and the preview picture.

## Using the viewer

1. **At rest, then loading.** The photo appears at once, framed exactly like the reconstructed camera, and the world starts loading behind it. A world opened on its own (a link, not a slide) starts with the keyhole at **an eighth of its size** (`KEYHOLE_REST` in `web/src/keyhole.ts`; never under 20 px tall, so on a phone it is still a keyhole), so the photo is whole around it. It sparkles so it is not missed: thin four-pointed glints catch one after another on its outline, over a soft amber light that swells and ebbs round it (`sparkle` in `KEYHOLE_LOOK`; with reduced motion the glints hold still). **Tap it** (or press Enter, or Tab to it and press Enter) and it grows to its full size in a second, the surround dims, and the loading below carries on from there. A slide played from the slide space has been tapped already (its flight grew the keyhole), so it starts at full size. The keyhole of the WOM logo (`favicon/wom.favicon.png`) is a round head on a body that flares out to a flat base, with sharp corners and a dot under it. At full size, while the world loads, it is an opaque dark pane with a lit outline (an amber line with a cream core, like a filament) that throws a soft glow onto the photo around it and onto the pane. The glow and the dot breathe slowly, the dot like a standby light, and every 6.8 seconds a white glint rises from the base up both sides and meets at the top. It uses one hue and slow motion, so it reads as precise technology rather than decoration. With reduced motion it holds still. The shape is `KEYHOLE` in `web/src/keyhole.ts` and the look is `KEYHOLE_LOOK` in `web/src/keyhole-light.ts`. As the world arrives, two lights rise from the base along both sides, the surround dims a little, and the label under the dot says how far along it is ("Loading the world · 42%"). A photo whose shape is close to the screen's fills the screen; other photos are shown whole on a blurred copy of themselves.
2. **Loaded, not yet entered.** When the two lights meet at the top of the head and the keyhole is full size (a keyhole tapped only after the world had loaded lights as soon as it has grown) the keyhole ignites: a light runs once round its outline, which then glows brighter, its dot stops breathing and stays lit, the pane inside dissolves into the live 3D world, and the rest of the photo darkens, so the keyhole is the brightest thing on screen. Now and then the light runs round the outline again. *Enter the world* fades in under it. The opening has depth: two inner walls shift against the rim as the camera moves. The camera behind it swings round the scene's focus point (about 7° from side to side and 4° up and down, so its path is a slow ellipse round the focus) and also turns on the spot, as a head does (about 3.5° and 2°), so the view direction itself changes by up to about 11° and the picture sweeps across the opening as well as shifting against itself. Your pointer adds to both. Near and far things shift against each other and you can see it is 3D. The amounts are `orbit` in `web/src/viewer.ts`. Hovering the keyhole widens it a little. With reduced motion set in the operating system the idle animation and the long transitions are turned down: the swing is smaller, the view does not turn, the pointer does nothing and the sparkle holds still.
3. **Inside.** Click *Enter the world*, click the keyhole or press Enter. The keyhole grows about the middle of its head, like an iris, past the photo's own borders (so the world also appears where a letterboxed photo had bars), until the world fills the screen. Then:
   - W A S D (or the arrow keys) walk, Shift runs, and the scroll wheel glides forward and back (Spark's `SparkControls`). You walk on the ground at the photo camera's height and bump into walls and objects; see [Walking and colliders](#walking-and-colliders).
   - F switches to flying, where Q / E go down and up and nothing stops you; F again drops you back onto the ground.
   - Drag to look around.
   - *Back to the memory* (P) flies back to the photo's viewpoint while the keyhole closes back in around the photo.
   - *Flag a problem* (O) records something that looks wrong here, with the exact camera and scene; see [Flagging problems](#flagging-problems-observe-to-fix).
   - *Capture* (the camera button) keeps what the camera shows now as a bookmark of the moment: a picture of the view and exactly where the camera stood, saved as another way into this world that opens from exactly here. On a large screen the button sits in a corner; on a phone it sits at the bottom centre like a camera app. A flash and a small card confirm it. The card has the picture, a name you can type over right away ("View 3" until you do), an optional caption, *See in slides* (a new tab, on this capture) and *Undo*; it leaves by itself after about nine seconds. See [Slides](#slides-choosing-a-world-and-how-to-enter-it).
   - *Layers* holds the Marble world (with a choice of splat resolution), the depth relief and the objects. *Layers → Movement* switches walking on and off and shows the colliders as wireframes (the world's in green, the objects' hulls in orange).
   - *Layers → Placement* switches every object between the fitter, the grounded fitter and the agents' placements (see [Placement choices](#placement-choices)). *Use for this world* keeps the selected one. *Placement agents* below it chooses which agents this world uses and runs a chosen one that has not placed the objects yet.
   - *Layers → Object models* chooses the 3D model each object shows and runs the [asset check](#asset-check).
   - *Edit layout* lets you click an object and move, rotate or scale it (G / R / T). *Save layout* keeps your changes and *Reset* restores the fitted poses.
   - *Export meshes (GLB)* downloads the mesh objects and the relief. Splat objects are not included.

### Walking and colliders

Walking needs no physics engine. The camera rides on an upright capsule whose radius and step height scale with the eye height. The capsule keeps to the ground with gravity, slides along whatever it touches, and steps up bumps up to a quarter of the eye height (at most 35 cm). Collisions use [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) against two kinds of collider:

- **The world.** Marble's collider mesh (`world/<model>/collider.glb`, 214k triangles for the backyard). It shares the splats' frame, so the viewer gives it the same calibrated rotation and metric scale. Worlds without a Marble world, or with the Marble layer hidden, walk on the depth relief.
- **Each object.** A convex hull computed by compose and stored in `scene.json` (`objects[].collider`, 170–980 triangles). For splats it wraps the splats at least 50% opaque, without the 0.5% furthest out along each axis. For Tripo meshes it wraps the mesh. Hulls follow placement switches and layout edits. A hidden object stops colliding.

The eye height is measured on entering: the distance from the photo's viewpoint down to the collider (0.86 m in the backyard). When nothing is directly below, as with a depth relief, which only covers what the photo shows, WOM uses the camera height from compose's ground plane (`camera.heightM`, 2.23 m in the courtyard). Past the edge of the collider the walker keeps its last ground height instead of falling.

Objects get hulls rather than their own meshes because collision cost grows with the triangles near the capsule, not with the total. Measured with a 30 cm capsule touching each surface:

| Collider | Triangles | Per collision check |
| --- | --: | --: |
| Marble world collider | 214,184 | 28 µs |
| Tripo H3.1 object mesh | 136k–144k | 12–23 ms (33k–64k triangles tested, 130–150 contacts) |
| Same mesh simplified | 2k–7.5k | 0.26–0.92 ms |
| Convex hull | 590–930 | 73–116 µs |

The world's triangles are spread over tens of metres, while an object packs 140k into about the capsule's own size. In the viewer a whole walker step, all colliders included, takes about 0.25 ms. Both worlds hold 60 frames per second while walking (headless Chrome, M1 Max). Hulls fill the gaps under a bench and between a bicycle's wheels, which is fine for walking. Clicking on objects still uses their full detail.

## WOM: World Observation Metrics

In the app, WOM is *World of a Memory*: one photo rebuilt as a world you walk through. The measurements of how well that rebuild matches the photo are *World Observation Metrics*, and they have a page of their own at `#/bench`, linked from the home page. The page reads what is already on disk and never makes a paid call.

The benchmark and its page are a package of their own, [`@wom/metrics`](packages/metrics/README.md): a framework that does not care which model, agent or process gives the answers. Applications declare *tasks* (the cases, and how an answer is scored) and plug in *subjects* (whatever answers); the framework runs them, caps and caches the paid calls, books them to the ledger, stores the runs and serves the page. This app supplies what it measures (`server/src/bench/`) and two tabs only it can fill (`web/src/wom.ts`).

| Tab | The question | Where the numbers come from |
| --- | --- | --- |
| Overview | What is the short version? | The other tabs: the headline numbers, what they say in plain words, every method's gain over the free baseline, and the hardest cases. |
| Placement | Where does each object sit? | The [placement benchmark](#placement-benchmark): a leaderboard, a chart of what a model buys in cost or time, a case × method matrix, and every case with its overlays. |
| Assets | Is anything from the photo baked into an object? | The [asset check](#asset-check): verdicts per 3D model next to how well that model's objects were placed, the agreement with the labels, and every asset. |
| Camera | Was the photo's camera read correctly? | Each depth model's field of view against the lens in EXIF, and against a phone's depth map. |
| Observations | What did people see while walking around? | The [observations](#flagging-problems-observe-to-fix): counts by status, layer and category, and the latest. The *Observations* page (`#/observations`) has the frames and the buttons. |
| Spend | What did it cost? | `data/ledger.jsonl`, through `GET /api/bench/spend`: by kind of work, provider, day and world. |

Placement and Assets are tasks (`server/src/bench/placement.ts`, `assets-task.ts`): a task registered in `server/src/bench/suite.ts` gets a tab, a run picker and a leaderboard or verdict view with no change to the page. Camera and Observations are tabs the app adds.

A tab's address is `#/bench/<tab>`, and `#/bench/<tab>/<run>` (or `#/bench/<run>/<tab>`) shows a particular run of that tab's task. The picker under the title lists the runs of the open tab's task and links its report and raw data. The tabs keep their filters and sort order while you look at another one.

**Methods are compared on the cases they share.** The models cost money, so the benchmark runs them on fewer cases than the fitters. A mean over all the cases a method ran compares different objects: in run 20261101-215829, Direct → fit with Muse Wonder looks better than the grounded fitter (0.79 against 0.74), but on the 4 cases both ran it is level with it (0.79 against 0.79). The leaderboard therefore adds *vs. baseline*, the method's mean IoU minus the grounded fitter's on the cases both ran, with how many were better, the same (within 0.01) and worse. A model-assisted method counts as a gain only above 0.02 IoU. Rows with fewer than five cases are marked.

**Cost and time per object.** A run answered from the cache has no cost, so the page prices each method from the ledger: what its model calls cost, averaged over the cases that were paid for (about $0.07 an object for Muse Spark's agent and $0.10 for Muse Wonder's). `direct+defer` and `direct→fit` are made from the direct answer, so they carry its price and time.

**The numbers are computed in one place.** `packages/metrics/src/core/analyze.ts` (summaries, comparisons on shared cases, agreement) and `packages/metrics/src/web/analytics.ts` (every derived figure and every sentence on the Overview) are plain functions over what the API returns, so each can be checked against the data.

## Flagging problems (observe to fix)

Some problems cannot be seen from the photo's own camera, so neither compose's `reprojection.jpg` nor the placement benchmark notices them. They show when someone walks around: a green sheet hanging off the backyard bicycle's wheel, streaks in the sky. The viewer already holds everything a report on such a problem needs, so *Flag a problem* (or **O**) records facts instead of guessing from a screenshot.

1. Press O, or *Flag a problem* in the top bar. The camera freezes. Click the problem or drag a box around it, pick a category, add a note, *Save flag*. Esc cancels.
2. The viewer captures the frame, the exact camera (position, rotation, field of view, clipping planes, gravity), which layers were showing, every object's asset file and transform, and the placement method.
3. It traces rays from the camera through the marked pixels (one spot gives five rays, a box gives 25) and records every layer each one hit, with distance and 3D point. It counts the splats of the nearest layer that project into the marked region at that depth: how many, how opaque, how flat (sheets and needles have a long axis many times the short one), and their bounds.
4. It draws the same view again with each layer hidden in turn, but only the layers the rays reached (the Marble world, the depth relief or an object): a layer no ray touched cannot be the problem. When no ray hit anything, as with faint haze, it hides each layer that was showing. The whole flag takes about four seconds.

The server stores this under `data/bench/observations/<world>/<id>/`: `observation.json`, `frame.jpg` (the frame, compressed once as a JPEG at quality 92), `thumb.jpg` (640 px wide, what a card shows), `tiny.jpg` (160 px wide, a tile in the strip of sightings), `all.jpg` and `without-<layer>.jpg`, and `after-<id>.jpg` once a fix has been confirmed. A flag takes about 0.5 MB on disk; with a PNG frame it took 2.7 to 3.5 MB. Flags made before this keep their `frame.png`, and their thumbnails are made the first time a list asks for them. The server also **decides which layer the problem is in**: the layer that is the nearest hit of at least 40% of the rays. The hide-one-layer frames are for a person to see what goes away, and they give a fallback when no ray hits anything. A person can change the layer on the Observations page.

The *Observations* page (`#/observations`, linked from the home page and from the metrics page) lists **problems**, 20 to a page, newest sighting first. A person flags what they see, so one problem arrives many times from different spots. Flags of one world that name the same layer (for an object, the same asset and mask version) and mark the same place are grouped into one problem. The same place means within 0.3 m plus 6% of the distance from the camera, measured on the suspect layer's surface; for an object it is measured in the object's own frame, so moving the object does not split its problem. Flags with no rays, and flags the asset check opened, stay on their own.

A card shows the clearest sighting (the one with the most rays on the suspect layer) as a thumbnail that opens the full frame, the marked spot, the layer, the splat statistics, and a strip of the other sightings. The hide-one-layer frames, with the suspect's outlined, load only when asked for. A problem has the status of its newest sighting (open, confirmed, false alarm, fixed, won't fix), so a flag made after a fix reopens it, and the flag overlay says so when you flag a spot that was flagged before ("this is the 3rd sighting"). Changing the status or the layer on a card changes all of its sightings at once. *Open at this view* reopens the world at the exact camera. When the layer is an object, the card suggests fixes (below). Flags the asset check opened have no camera, so their card lists its findings and offers *Open the world* instead.

**Links to a view.** `#/world/<id>?view=x,y,z,qx,qy,qz,qw` opens inside the world at that camera, without the portal. *Layers → This view → Copy link to this view* makes one. Add `&compare=<flag id>` to lay that flag's frame over the view (see *Compare at this view* below).

**Suggested fixes.** Only objects can be repaired so far. For a problem in an object the card lists what can be done, best first, each with its evidence and its price. The order is a plain rule over what the server already holds (the flag, the object's models, their asset checks), so the same flag gets the same list every time:

1. Show another model of the object whose asset check found it clean (free), then one with only minor leftovers.
2. Check the models that have no verdict yet. The asset check is the AI step: a vision model looks at a turntable of each model. It costs up to $0.02 each (measured about $0.009). The flagged model is not checked again, because a person has already judged it.
3. Show a model that has no verdict (free, but it may have the same problem).
4. Make a new model of this one object, offered only when nothing the object has is good or still unchecked ($0.05 to $0.50 by model, plus a check). It is checked as soon as it exists.
5. Redo the mask by hand on the build page. That removes the cause (gaps the mask fills in) and rebuilds only this object.

A model whose check found leftovers is not offered, and the card says so. A fix that charges asks twice: the button names the most it can cost, and a second click spends it. *Show it* is free, takes a few seconds, and is saved on the object (`pinnedModel`), so rebuilding the other objects keeps it. The card and every flag of the problem note what was done ("Showed the Tripo H3.1 mesh instead of the IDOL splat"). The problem's status does not change until a person has looked. Nothing repairs the Marble world or the depth relief yet, and a flag about placement points to the placement controls instead.

**Compare at this view.** After a fix the card offers *Compare at this view*. It opens the world at the flag's own camera and holds the camera there, with the flagged frame laid over the live view. Drag the line (or press ← →) to wipe between what was flagged and what the world shows now. The two line up exactly: same position, rotation and field of view, and the frame is scaled if the window's field of view differs. In a window shaped like the flag's, they differed by 0.8 of 255 on average away from the changed object. *Looks fixed* marks every sighting of the problem fixed and keeps a 640 px picture of the view as it is now (`after-<id>.jpg`), and the card then shows both pictures. *Still wrong* opens the flag overlay from the same camera. Esc closes the view. A mesh replacing a splat looks different, which is why a person confirms.

**For agents and scripts.** Open the app with `?debug` (for example `http://localhost:5173/u/-/<id>?debug`) and `window.__wom.viewer` offers what a person does by hand: `ready()`, `enter()`, `setPose({position, quaternion})` (holds the camera until `unfreeze()`), `layers()`, `setLayer(id, shown)`, `frame()`, `pick([x, y])` (the rays' hits at a frame pixel), and `flag({mark, note, category, author: 'agent:<name>'})`, which makes the same record. `compare(id)` holds the camera at a flag's own camera and lays its frame over the view; `closeCompare()` lets go. It also saves and reads slides (`saveSlide()`, `entry()`, `home()`; see [Slides](#slides-choosing-a-world-and-how-to-enter-it)). Or post a flag yourself:

```
POST  /api/worlds/<id>/observations         multipart: record (JSON), frame (PNG or JPEG), ablate:all and ablate:<layer> (JPEG)
GET   /api/issues?world=&status=&limit=&offset=   problems, newest sighting first, without the rays (limit 1 to 100, default 20)
GET   /api/observations?world=&status=      every flag with its rays, newest first (for counting; to list, use /api/issues)
GET   /api/worlds/<id>/observations/<oid>
PATCH /api/worlds/<id>/observations/<oid>   { status?, note?, category?, suspect? }
PATCH /api/worlds/<id>/observations         { ids: [...], status?, note?, category?, suspect? }: the same change to several flags
GET   /api/worlds/<id>/observations/<oid>/fixes   what can be done about its problem, best first: { object, fixes: [{ id, kind, title, because, costUsd, … }], notes }
POST  /api/worlds/<id>/observations/<oid>/fix     { fix, approveUsd?, by? }: runs in the background (poll GET /api/worlds/<id> until it is not running)
POST  /api/worlds/<id>/observations/<oid>/fixed   optional multipart `after` (PNG or JPEG): every sighting of the problem becomes fixed
```

`POST` answers with the saved flag and the problem it now belongs to (`issue: { id, count, status, reopened }`). A JPEG frame is kept as sent, so it is not compressed twice. Fix ids are `use:<model>`, `check`, `generate:<model>` and `mask` (by hand: the server never runs it). The server works the list out again for every request, so a fix that is no longer offered (the world changed) is refused with 409, and one that charges is refused with 402 unless `approveUsd` is at least its `costUsd`. A fix started while the world is busy gets 409 too. `GET /api/issues` answers with `issues` (each with its `best` sighting, up to 12 `sightings`, every flag id in `ids`, `location`, `reopened`), the `total` that match, and the counts for the whole set (`all`, `flags`, `byStatus`, `worlds`). The pictures are at `/bench-files/observations/<world>/<oid>/<name>`.

**Many flags.** A page of 20 problems is about 136 KB of JSON, where the full list of 1,540 flags is 8.5 MB. A list reads every flag's `observation.json`, so its time grows with the number of flags: 175 to 250 ms at 1,540 flags. Around 10,000 flags it would want an index (not built).

Layer ids are `world`, `relief` and `object:<object id>`. The server checks everything it is sent before writing anything: a rejected flag leaves nothing on disk. `suspectHint` lets an author with no rays name a layer.

## Slides: choosing a world and how to enter it

`#/space` (*Browse as slides* on the home page) shows every built world as a glass slide in a row along a timeline of when each memory was made. Scroll, drag or press ← → to look through the row (Home and End jump to the ends). The slide in front steps out of the row and turns toward you with its keyhole showing: at an eighth of its full size, sparkling. Tap the keyhole (its button is a disc at least 56 px across, however small it rests) or press Enter: the rest of the row fades away while the slide turns to face you and grows into exactly the frame the viewer shows its picture in, and the keyhole grows with it, from its resting size to its full size by the time the slide lands. That keyhole is the one the world loads behind, so the viewer takes over from the slide with nothing jumping, and the loading sequence runs from there. The viewer's back arrow flies the slide home again. Slides have square corners. The keyhole's light is a function of the clock alone (`web/src/keyhole-light.ts`), so the one on the slide, the one on the slide's cover and the one in the viewer are the same drawing of the same moment, which is why nothing jumps when the viewer takes over.

The camera does not move. The slide turns to face it and lands on the rectangle of the window that `web/src/frame.ts` also gives the viewer, which is what keeps the two pages aligned.

**A slide is a picture and the camera that took it.** The camera is the slide's *entry*: `position`, `quaternion` (x, y, z, w), `fovY` (vertical field of view in degrees), `aspect` (width / height) and optionally `focus`, the distance to what the middle of the picture shows (the portal camera swings around that point). The viewer opens the world from the entry, so the world looks like the picture when you arrive.

- Every built world has a **photo slide** (id `photo`): the photo, entered from the camera that took it, which is the origin of the scene. It is derived from `scene.json` and never stored.
- **View slides** come from inside a world. The camera button in the viewer saves exactly what the camera shows, without colliders or the edit gizmo (a JPEG of at most 2048 px), with the camera as its entry. The camera is read in the same moment the picture is drawn, so walking or flying while pressing it does not move the saved position away from the picture. A view made in a Marble world remembers the world's calibration. When compose later calibrates the world differently, the entry moves with it, so the view still matches its picture.
- A view's **name and caption** belong to its bookmark. The name starts as "View 1", "View 2", … and can be changed in the capture card. The card also accepts an optional caption of up to 2,000 characters, with line breaks, and saves edits as you leave each field. The name and caption are returned with the slide and the caption appears in the slide-space details.
- Views are stored with the world: `slides.json` (`{"slides": [...]}`), `slides/<id>.jpg` and `slides/<id>-thumb.jpg` (at most 640 px).

**Sub spaces.** The stack opens on any list of slides. The app has three. Each takes `?slide=<world>.<slide>` for the slide to start on (default: the newest).

| Address | Shows |
| --- | --- |
| `#/space` | every slide of every built world, by the date of the memory |
| `#/space/world/<id>` | one world's ways in: its photo, then its views in the order they were made (a slide offers it as *All N ways in* when its world has more than one) |
| `#/space/year/<yyyy>` | the memories of one year (the timeline's year labels open these) |

Esc, the back arrow and the trail in the top bar lead back up. The viewer opens from a slide at `/u/<handle>/<id>?slide=<slide id>&from=<space>`, where `from` is the space it was played in (`all`, `world/<id>` or `year/<yyyy>`), so its back arrow returns to that space, on that slide. Playing a slide and the back arrow change the address without a page load (`navigate` in `web/src/main.ts`, which also takes in-app links such as `#/space` clicked on a world's page), so the slide's cover reaches the other page, and `?debug` stays on the address. A new kind of sub space is one more entry in `SPACES` in `web/src/slides/spaces.ts` (an address pattern and a filter). `createSlideSpace(mount, { slides, … })` in `web/src/slides/space.ts` builds a stack from any list. A stack fills the window and listens for keys on it, so a page holds one.

**HTTP API.** Slides are read and written through the same server as everything else:

```
GET    /api/slides                     every slide of every built world (worlds still being built are left out), by the memory's date
GET    /api/worlds/<id>/slides         one world's: the photo first, then its views oldest first; [] until the world has a scene
POST   /api/worlds/<id>/slides         multipart: record (JSON) and image; 201 and the new slide
PATCH  /api/worlds/<id>/slides/<sid>   {"title": "…", "caption": "…"} updates a view's name and/or caption and answers with the slide; its picture and camera do not change. An empty caption clears it; a name with nothing visible is refused. 404 for no such slide, 409 for the photo slide
DELETE /api/worlds/<id>/slides/<sid>   removes a view and its files ({"ok": true}); the photo slide answers 409
```

A slide as returned: `{ id, world, worldTitle, kind: 'photo' | 'view', title, caption?, takenAt, createdAt, image: { url, thumb, width, height }, entry }`. To add one without the viewer, render the world from a camera yourself and post the picture with that camera (`aspect` is the picture's width / height: 1.5 for a 3:2 picture):

```bash
curl -F 'record={"entry":{"position":[0,0,-0.5],"quaternion":[0,0.208,0,0.978],"fovY":41.2,"aspect":1.5,"focus":2.5},"title":"From the gate","caption":"The first view after the gate."}' \
     -F 'image=@view.jpg' http://localhost:5173/api/worlds/<id>/slides
```

`entry` uses three.js camera conventions (the camera looks down its −Z axis) in the scene's own units. `title` and `caption` are optional (the default title is "View 1", "View 2", …). Captions can be up to 2,000 characters and can contain line breaks. The server checks everything before it writes anything, so a refused slide leaves nothing on disk. It answers 400 with `{ "error": … }` for a malformed record or an unreadable picture; for a picture that is not a JPEG, PNG or WebP from 64 to 8192 px; for a `fovY` outside 5–150 or an `aspect` outside 0.2–5; and for a picture whose shape is more than 2% off `entry.aspect`. It answers 413 above 16 MB, and 409 when the world has no scene yet or already holds 200 views.

**For agents and scripts.** With `?debug` in the address, the viewer page offers `window.__wom.viewer` (typed as `ViewerApi` in `web/src/observe.ts`) and the space pages offer `window.__wom.space` (typed as `SpaceApi` in `web/src/slides/space.ts`). Each is set when its page opens. Moving to another page by changing the address keeps the page, so the one you left stays there, stale.

```js
// http://localhost:5173/u/-/<id>?debug
const v = window.__wom.viewer;
await v.ready();                 // 'portal' once the world has loaded
v.enter();                       // inside, without the portal animation
v.setPose({ position: [0, 0, -0.5], quaternion: [0, 0.208, 0, 0.978] });
v.unfreeze();                    // setPose holds the camera, and saving is declined while it is held
// give Spark a second to sort the splats for the new camera, then:
const slide = await v.saveSlide();   // what the Capture button does (the card shows too): the new slide, or null when nothing was saved
v.entry();                       // the camera this world was opened at (null until it has loaded)
v.home();                        // the portal camera at rest, which "Back to the memory" returns to

// http://localhost:5173/?debug#/space
const s = window.__wom.space;
s.keys();                        // ['<world>.photo', '<world>.<slide>', …] in the order shown
s.select('<world>.photo');       // bring one to the front (only while the row is at rest)
s.state();                       // { mode: 'browse', current, key, count, … }
s.play();                        // fly the slide in front into its world
s.flight();                      // while a slide flies: { u, dir, box, rect }; otherwise null
```

A change of address keeps the page, so after moving to another space wait for its title before reading `window.__wom.space`: it is replaced when the new space mounts.

**Checks.** Four scripts drive headless Chromium over the real app and API. `npm run slides:e2e -- [world id] [WxH] [tag]` saves a view in a world, finds it in the world's space, plays it (the flight must land on the viewer's frame to a fraction of a pixel, and the world seen from the saved entry must look like the slide's picture), comes back and removes the view again. It writes one slide and removes it, even when a check fails. `npm run slides:input` covers the wheel, drag, click, Esc and reduced motion, and writes nothing. `npm run slides:seam -- [slide key] [WxH] [tag]` plays a slide with a slow network and reports how much the screen changes at each step of the hand-off. `npm run slides:visual -- [WxH] [tag]` shows the row with 26 made-up slides to judge the layout. Playwright is not a dependency of WOM: run `npm i -D playwright-core`, or set `PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core`. `BASE` is where the app runs (default `http://localhost:5173`, what `npm run dev` serves; the API is reached through it). Screenshots go to `data/checks/slides/<tag>`, and a failed check sets the exit code. The scripts share `scripts/slides/browser.mjs`.

**Before running anything against this data:**

- Start your own servers rather than restarting one that is already in use: `PORT=8811 node --env-file-if-exists=.env server/src/index.ts`, then `PORT=8811 npx vite --port 5211 --strictPort` (`PORT` also tells Vite where the API is), and `BASE=http://localhost:5211`.
- A server that starts on a data folder resumes every world whose status is `running` or `queued`, and that spends money. Look at `data/worlds/*/manifest.json` first.
- A server reads a world's manifest once and keeps it. A world built or finished by another process shows up after a restart.
- Slides made for a test are real data. Remove them (`DELETE`, or *Remove slide* in the world's space) and check `data/worlds/*/slides.json` when you are done.

## Asset check

Objects are cut out of the photo with a mask and rebuilt from that cutout. Whatever the photo showed through gaps in the mask (lawn between a bicycle's spokes, a hedge behind bench slats) is rebuilt too, as flat sheets or lumps hanging off the object. That is the green sheet on the backyard bicycle: its mask fills both wheels, and IDOL and TripoSplat rebuilt the lawn and hedge behind them. The placement benchmark cannot see it, and rewards it, because the mask has the same mistake.

The check renders the asset's turntable (the same renderer and eight yaws the placement agents use), asks Muse Spark which parts of it are not the object, and decides the verdict from the findings in code: any major finding, or more than 12% of the visible area, is *contaminated* (shown as "background inside"); any finding, or more than 3%, is *minor*; otherwise *clean*. It costs about $0.009 per asset and is cached by content, so repeating it is free.

- **In a build.** Right after the 3D models are made, the check looks at the asset each object shows. A problem is logged, shown on the build page under the object, and added to the *Shaping the objects in 3D* step's message. It never fails a build.
- **Flagged for inspection.** A *contaminated* verdict on the asset an object shows also opens a flag on the [Observations page](#flagging-problems-observe-to-fix), from the build or from *Check N assets* (author `agent:asset-check`, category *Background inside an object*). Its frame is the turntable the checker saw, with the tile where it saw the problem marked, and the build page links to it. An asset gets one such flag, so one marked *False alarm* stays closed. *Minor* verdicts are not flagged.
- **In the viewer.** *Layers → Object models* lists, per object, every model it has an asset for, with the verdict. *Check N assets* runs the check on those without one (about two cents each, free for answers already cached).
- **A model per object.** Choosing a model there shows it for that object only (`POST /api/worlds/<id>/objects/<oid>/asset {model}`). It is free: the asset already exists, and compose fits it again, which took about fifteen seconds on the backyard world. The choice is kept on the object as `pinnedModel`, so a retry or another object's mask redo does not undo it. Redoing the object's own mask clears it, and switching the whole world's model resets every object. The object's saved layout (*Save layout*) is dropped, because it was made for the other asset's frame and scale.
- **Benchmark.** `npm run bench:assets` checks every asset of every built world (options: `--worlds`, `--objects`, `--assets`, `--model`, `--effort`, `--max-usd`, `--fresh`, `--cached-only`) and writes `data/bench/assets/<run>/` with `report.md`, `results.json` and each turntable. It is the `assets` task of [`@wom/metrics`](packages/metrics/README.md) (`server/src/bench/assets-task.ts`). The Assets tab of the metrics page shows the runs: verdicts per 3D model, the agreement with the labels, and every asset with the turntable the checker saw. The labels are read each time a run is shown, so a label added later applies to the earlier runs too.

`data/bench/asset-labels.json` holds what a person saw in each turntable (`"<world>/<object>/<asset>": { "verdict": "clean" | "minor" | "contaminated", "note": "…" }`), and the report compares the checker with it. On the 22 assets of the two sample worlds it matched 20, caught all 3 contaminated assets (the IDOL and TripoSplat bicycles, and a floating box beside the Tripo H3.1 lemon tree) and flagged none of the 16 clean ones. It missed an olive-green patch on the TripoSplat dog, and called the IDOL lemon tree's dark slabs contaminated where a person said minor. Treat the numbers with care: five labels were set before the checker ran, the rest after seeing its verdicts, and assets called clean were checked at four of the eight yaws.

## Placement benchmark

`npm run bench:placement` compares Muse Spark 1.3, Muse Wonder 1.0 and the geometric fitter at putting each object's 3D asset back where it is in the photo. It runs on worlds that are already built and reuses their masks, depth and assets; it never generates 3D. The only paid calls are to the language models, and they are cached by content in `data/bench/cache/llm`, so a re-run with the same inputs costs nothing.

It runs on [`@wom/metrics`](packages/metrics/README.md). `server/src/bench/placement.ts` defines the `placement` task (which cases there are, how a placement is scored) and the subjects that answer it (the geometric fitters, and a Muse model with the `direct` and `agent` protocols); budgets, the call cache, the ledger, the stored runs, the reports and the page belong to the framework. Runs made before the framework (a `results.json` without `format: 2`) are converted when they are read, and nothing on disk is rewritten.

Both models get the same briefing: the asset's canonical frame (+Y up), its base pivot (the centre of its footprint on the ground), the yaw convention, a turntable of the asset rendered from the photo camera's viewing angle at eight yaws, the camera's field of view, height and pitch, and how their answer becomes 3D. They are told what the geometric fitter does, and they can hand any part to it.

| Method | What places the object |
| --- | --- |
| `fitter` | The compose fitter: silhouette against the SAM mask, distance from MoGe depth. |
| `fitter-grounded` | The fitter kept upright, then scaled about the camera so the base pivot rests on the ground plane. The silhouette does not change. |
| `direct` | One structured answer from the model: base point, height, yaw, tilt. The base point is put on the ground plane. |
| `direct+defer` | The quantities the model chose to defer (position, scale, yaw) are decided by the fitter; the rest stays as the model said. |
| `direct→fit` | `fitter-grounded`, searching only ±30° around the model's yaw. |
| `agent` | The model with tools: `render_placement` (scores and an overlay image), `auto_fit` (`fitter-grounded`), `measure_depth` (MoGe), then `submit_placement`. |

Scores are measured from the photo's camera: silhouette IoU against the SAM mask, colour error where the asset covers the object (a wrong yaw raises it), depth agreement with MoGe, the gap between the asset's lowest point and the ground, and tilt from gravity. Each run writes `data/bench/placement/<run>/report.md` with tables and overlay sheets, `results.json` with every answer, tool call and score, and the exact images the models saw. A run with several asset or depth models also gets an *Assets and depth* table: the fitter's and the grounded fitter's IoU for every asset × depth combination, per world and object.

The same reports are on the Placement tab of [WOM: World Observation Metrics](#wom-world-observation-metrics) (`#/bench`, linked from the home page), with every case's overlays and a link to the world's viewer, where the placement is chosen.

```bash
npm run bench:placement -- --max-usd 3                      # IDOL assets, each world's active depth
npm run bench:placement -- --assets idol,triposplat,tripo-v31,tripo-p1 --depths moge2,moge3 --cached-only
npm run bench:placement -- --worlds <id> --objects golden-retriever --protocols agent
```

Options: `--worlds`, `--objects`, `--assets` (default `idol`), `--depths` (`moge2`, `moge3`; default: each world's active one), `--models`, `--protocols direct,agent`, `--effort` (default `medium`), `--max-usd` (default 4), `--concurrency`, `--fresh`, `--cached-only` (no new model calls; the fitters still run, so asset and depth comparisons are free), `--report <run dir>`. A depth model is only used where the world already has it.

IoU is only meaningful when the SAM mask covers the right object, and it rewards an asset for copying the mask's mistakes: the backyard bicycle's mask fills the gaps between the spokes, and IDOL and TripoSplat rebuild the grass seen through the wheels, so they score higher there than the Tripo meshes, whose wheels are open. Each case on the Placement tab also shows the asset's turntable, so you can check this. `data/bench/annotations.json` holds notes per case (`"<world>/<object>": { "exclude": true, "note": "…", "maskVersion": 1 }`; with `maskVersion` the note applies only to that mask of the object); excluded cases stay in the details but leave the summary table. `--report <run dir>` rebuilds a report after editing it. The report also warns when every model-only placement misses the mask while the fitter matches it, which is how the mis-segmented wellhead in the courtyard sample showed up.

## Standardized visual patrol

`npm run bench:patrol` walks a fixed camera path through each built world and asks several vision models the same question about every frame: what, if anything, looks broken? It scores the world and not how it was made, so worlds from different generators can be put side by side.

**The path** is the same rules in every world, placed by that world's own geometry: the photo's camera; a step left, right and forward; a low and a high view; then two views of each object from either side, framed by its collision hull. Distances scale with how far away the photo's subject is, and eye height is the photo camera's. A camera is used only where a person could stand and look, checked against the walker's colliders (the world, the relief and every object): room around it, a clear walk to it from the photo camera, ground at standing height below it, and some distance to see ahead. A cramped world, such as a vanity table, therefore gets fewer views (7 of 16 or 18 for the two in the sample data) and says which were left out and why; it is never judged from inside a table. Frames are taken after Spark has sorted its splats again, so lag is not mistaken for a defect, and a flat-coloured frame (the camera in a wall) is dropped, because it would score as perfect.

**The judges** are Muse Spark 1.3, Gemini 3.8 Flash and GPT-6.1 Terra. Each gets the original photo, one frame, one prompt and one JSON schema, and answers with findings: a category (floating bits, background inside an object, smeared, hole, placement, other), a severity, a confidence, a tight box and a sentence.

**The score** is **Intact**: 100% minus the mean share of a view covered by the judge's defect boxes. A major defect counts in full, a minor one at half, and overlapping boxes count once. Clean views (the share of views with no finding), Worst view and the consensus figures (only defects that at least half of the judges report in the same place and category) sit beside it; Judge agreement says how much the judges agree, not whether they are right. **Coverage** says how many of the planned views could be inspected: a world with little room is judged on fewer, usually easier views, so read its Intact with its Coverage. Scoring by area matters: on the backyard world one judge gave 91% intact with only 1 of 14 views free of any finding, and a score of "any finding" would have put every world at 0%.

This is a **VLM-reported score, not yet a human-verified one**. A judge can miss a defect or invent one. Findings can be recorded through the observe-to-fix API as `agent:patrol-<model>`; marking them confirmed or false alarm on the Observations page is what measures each judge's precision, and until enough are marked the score is a relative measure. The path's own choices (distances, eye height, the half weight of a minor defect, what counts as room to stand) are part of the score, so scores from different versions are not comparable: the benchmark version (`patrol-v3`) is recorded with every run. A cached judgement is keyed by what the judge was shown (the pose, the frame's world, the prompt, the schema), so changing the path asks again only for the views whose camera moved.

**Comparing generation approaches.** Each case carries how its world was made, read from the world itself: the 3D model of its objects, whether it has a Marble world, and the depth model. The Patrol tab groups them in *Generation approaches*: intact per judge for each way of making a world, with the number of worlds behind it.

Paid calls are cached by content under `data/bench/cache/patrol`, so a re-run with the same frames is free. A run keeps the frame sheet and, per world, the full evidence (`evidence/<world>.json`).

```bash
npm run bench:patrol -- --models muse-spark-1.3,gemini-3.8-flash,gpt-6.1-terra --max-usd 2.5 --no-record   # every world
npm run bench:patrol -- --worlds <id> --models gpt-6.1-terra --max-usd 0.3 --no-record                    # one world, one judge
npm run bench:patrol -- --cached-only --no-record                                                          # no new calls
```

Options: `--worlds`, `--models`, `--max-views` (default 20), `--effort`, `--max-usd`, `--concurrency`, `--fresh`, `--cached-only`, `--no-record` (do not file findings as observations), `--record-cached`, `--base` (where the app runs). It drives a real Chromium: set `PLAYWRIGHT_CORE` to a `playwright-core/index.mjs` if it is not installed here, and have the app running.

Keys: `MUSE_API_KEY`, `OPENAI_KEY` (in `.env.local`) and, for Gemini, either `GEMINI_API_KEY` or a verified Google Cloud project in `.kiro/gcp-project.json` (Vertex AI through the local `gcloud` login; the project is never taken from gcloud's global setting). That file is per machine and not in git: copy `.kiro/gcp-project.example.json` and fill in your own `projectId`. The key route works anywhere, AWS included.

## Running on a server

The server is one Node process. It builds worlds in the background and keeps their files on its own disk, so run one instance, not a function platform. This repository holds no deployment scripts or cloud configuration; those stay with whoever runs the site.

1. `npm ci`, then `npm start` (it builds the web app into `dist/` and serves it and the API from one port), or `npm run build` and then `npm run serve`.
2. Set `HOST` to the address the process should listen on. Anything but `127.0.0.1`, `localhost` or `::1` turns sign-in on. Set `WOM_AUTH=required` as well when a proxy on the same machine fronts it.
3. Give it the keys from `.env.example`: the model keys, both Clerk keys, `CLERK_AUTHORIZED_PARTIES` (the exact origins the site is served from) and `WOM_PUBLIC_ORIGIN` (for link previews).
4. For shared worlds and credits, set `WOM_STORE=postgres` with `DATABASE_URL` and `DATABASE_URL_SYSTEM`. Never give the server `DATABASE_URL_ADMIN`. See [Postgres](#postgres).
5. Put `WOM_DATA_DIR` on a disk you back up. It holds every world and `ledger.jsonl`.
6. Terminate HTTPS in front of the process. Allow the proxy's addresses to reach the port and nothing else.
7. Worlds made on a laptop can be published. Copy `data/worlds/<id>` to the same place under the server's data directory, then run `node scripts/import-worlds.mjs --env <env file with DATABASE_URL_ADMIN> --owner <handle> <id>`. The owner must have signed in once, so that they have a handle.

## Demo: the head/body split

`demo/object-split/` is a self-contained static page for [Splitting people into a head and a body](#splitting-people-into-a-head-and-a-body): an animated story, a live 3D viewer, the measurements and every part the split produced, for one photo. It has no build step. `node demo/object-split/serve.mjs` serves it at http://127.0.0.1:8790/.

Its six full-quality PLY files (107.5 MB) are not in git, to keep the repository small. The page works without them and lists them by name, and the rebuild scripts that read them say so in [its README](demo/object-split/README.md).

## Secrets and local files

Git ignores every `.env*` file except `.env.example`, which holds names and empty values only. Keys, certificates and Terraform state are ignored too (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `service-account*.json`, `*.tfvars`, `*.tfstate`). `data/` (worlds, which keep the original upload with its metadata, and the ledger), `.scratch/` and `dist/` are ignored.

| Secret | Where it lives |
| --- | --- |
| `MUSE_API_KEY`, `AI3D_API_KEY` | `.env` on your machine. On a server, the server's own secret store or environment |
| `DATABASE_URL`, `DATABASE_URL_SYSTEM` | `.env`, or a second env file for another database (for example `.env.main` for production). On a server, its secret store |
| `DATABASE_URL_ADMIN` | Env files on your machine only. It is the database owner's URL: the server never reads it and it is never sent to a host |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `.env` or the server's secret store. The publishable key is public by design and the browser receives it from `/api/auth/config` |
| `STRIPE_WEBHOOK_SECRET` | The server's secret store only. Never in a file in the repository |
| `OPENAI_KEY`, `GEMINI_API_KEY` | `.env.local` |

Other files that stay on your machine:

- `.kiro/gcp-project.json` names the Google Cloud project that the Gemini judge uses through your `gcloud` login. It is ignored. Copy `.kiro/gcp-project.example.json` to create it. `.kiro/settings/` is ignored as well.
- `_testers/` is for test photos. A phone photo carries its GPS position and device in its EXIF data, so it is ignored.

Nothing that identifies the cloud account, the hosting or the Stripe account is in the repository. The production runbook and scripts are in `deploy/`, which is ignored. The one Stripe value that is in git on purpose is each pack's Payment Link id and URL in `server/src/packs.json` (test mode), because the server needs the id to match a webhook and the URL is what a buyer clicks.

If a secret is ever committed, treat it as exposed. Rotate it in the provider's console first. Deleting the file does not remove it from git history.

## Project layout

```
server/src/
  index.ts              HTTP API, SSE progress, artifact files, the /u/ pages and their link previews
  store.ts              worlds on disk (data/worlds/<id>/manifest.json + artifacts); with WOM_STORE=postgres also a row per world
  config.ts             environment, defaults, world options, sign-in and storage mode
  db.ts                 Postgres pools: asCaller (row-level security applies) and asSystem
  auth.ts               Clerk: verifies the session cookie, serves the publishable key
  access.ts             who is asking, who may do what (RULES), what a shared world exposes
  users.ts              people and their handles
  credits.ts            balances, holding credits for a world, promo codes
  stripe.ts             credit packs (packs.json) and the signed webhook that adds the credits
  share.ts              the tags a pasted link to a shared world shows
  clients/meta.ts       Muse Spark/Wonder chat, SAM 3.1, Muse Image
  clients/openai.ts     GPT-6.1 Terra structured visual judge
  clients/gemini.ts     Gemini 3.8 Flash through Vertex AI and gcloud
  clients/ai3d.ts       AI3D uploads, jobs, artifacts
  pipeline/run.ts       orchestration, resume and retry
  pipeline/*.ts         analyze, segment, cleanplate, cutouts, generate (MoGe/IDOL/Tripo/Marble), compose
  pipeline/placements.ts  the placement choices (grounded fitter, agents) after compose
  pipeline/remask.ts    redo one object's mask with SAM 3.1 points/box; mask versions and history
  pipeline/split.ts     head/body split of a person: SAM part masks, the cut, the hidden jaw, the regions for the corrector
  pipeline/align.ts     compose's alignment of a split person: the cache key, the worker thread, the aligned files
  pipeline/photo.ts     uploads: JPEG/PNG/WebP/AVIF, HEIC frames and depth (ImageIO or libheif), video frames (ffmpeg), lens from EXIF
  pipeline/camera.ts    depth models against the real camera (lens field of view, phone depth map)
  pipeline/assets.ts    per-model registry of generated 3D assets and depth maps, migration of older worlds
  geometry/*.ts         EXR/SPZ/PLY/GLB loading, rasterizer, pose fitting, ground plane, Marble calibration, relief mesh
  geometry/hull.ts      convex hulls of splats and meshes, used as walking colliders
  geometry/splat.ts     CPU Gaussian-splat renderer that follows Spark, and PLY reading and writing (for alignment and its checks)
  geometry/warp.ts      moves a part's Gaussians sideways in the photo's view until its render matches the photo
  geometry/holefill.ts  closes the gaps that open between two parts seen from the side, where the photo's camera cannot see
  geometry/corrector.ts makes chosen regions (eyes, brows, lips, nose) reproduce the photo
  geometry/alignJob.ts  the three in order as one job; alignWorker.ts runs it in a worker thread
  bench/case.ts         one object × asset: fitters, model inputs and tools (shared by the benchmark and the pipeline)
  bench/*.ts             what the benchmarks measure, on @wom/metrics: placement, assets and the standardized visual patrol
  bench/spec.ts         the tasks as data: metrics, families, how methods are named
  bench/placement.ts    the placement task and its subjects (the fitters, a Muse model); assets-task.ts is the asset-check task
  bench/suite.ts        the benchmark with placement, asset-check and patrol tasks registered, and the routes the page reads; usage.ts says what the ledger's labels mean; legacy.ts reads runs made before the framework
  bench/patrol.ts       the deterministic camera path, shared VLM prompt/schema, judge adapters, consensus and observation flagging
  bench/assetcheck.ts   the asset check's judge (shared by the pipeline)
  pipeline/assetcheck.ts  the check for a world's own assets: after the 3D models, and on demand
  observe/store.ts      observations: validation, deciding the layer, grouping flags into problems, thumbnails, storage under data/bench/observations
  observe/fixes.ts      suggested fixes for a problem (ranked from the flag, the object's models and their checks) and applying them
  ledger.ts             data/ledger.jsonl, every paid call (the metrics package's Ledger on the app's data folder)
  slides.ts             slides: every world's photo slide, the views saved inside it, their validation and storage (slides.json)
server/tools/imageio-extract.swift   macOS helper that decodes HEIC/HEIF with every frame and auxiliary image
server/tools/libheif-extract.py      the same for other servers, with libheif (pillow-heif); same JSON on stdout
scripts/dev.mjs              npm run dev: the API (watching its files) and Vite together
scripts/make-sample.ts       makes a sample photo with Muse Image
scripts/bench-placement.ts   benchmark CLI
scripts/bench-assets.ts      asset check CLI
scripts/bench-patrol.ts      standardized visual patrol CLI
scripts/db-roles.mjs         gives the database roles their passwords and writes the connection strings to .env
scripts/db-admin.mjs         makes someone an administrator (or takes it away)
scripts/import-worlds.mjs    puts worlds that exist as files into the database, as someone's worlds
scripts/promo.ts             makes promo codes (npm run promo)
scripts/stripe-packs.mjs     makes the credit packs in Stripe (test mode) and writes server/src/packs.json
scripts/stripe-cli.mjs       runs the Stripe CLI for stripe-packs.mjs; it refuses to touch anything in live mode
db/migrations/001_init.sql   the Postgres schema: users, worlds, ledger, observations, slides, credits, promo codes, row-level security
demo/object-split/           a static demo page of the head/body split (README.md inside)
favicon/                     the WOM logo as a PNG, with and without a background; the keyhole's shape is measured from it
.kiro/gcp-project.example.json  the shape of the per-machine .kiro/gcp-project.json that the Gemini judge reads
scripts/slides/*.mjs         browser checks of the slide space (npm run slides:e2e, slides:input, slides:seam, slides:visual); browser.mjs holds what they share
web/src/                home, build progress, viewer (three.js + Spark), mask editor (maskeditor.ts); wom.ts gives the metrics page (@wom/metrics/web) its Camera and Observations tabs and its links
web/src/auth.ts         sign-in: loads Clerk only when a session exists or the visitor asks, and draws the account menu
web/src/routes.ts       browser addresses: /u/<handle>/<world> and /build, and the conversion of old #/world/<id> links
web/public/             favicons, the preview picture, robots.txt and sitemap.xml
web/src/aperture.ts     the keyhole aperture before you enter: its rest at an eighth of its size and the wake that grows it, the dark pane and the rising trace, ignition, depth walls, and the growth into the world (draws only; the viewer drives it)
web/src/keyhole.ts      the keyhole's shape, from the WOM logo: its outline, its two sides (for lights that rise up both), its dot, its resting size (KEYHOLE_REST), and how far it grows to fill the window
web/src/keyhole-light.ts the keyhole before its world loads (KEYHOLE_LOOK): pane, outline, glow, dot, glint and the sparkle of a keyhole at rest, drawn from the clock alone so every copy shows the same moment
web/src/frame.ts        the rectangle a picture fills in the window, shared by the slide space and the viewer so a slide lands exactly where the viewer draws it
web/src/slides/         the slide space: space.ts (the stack and its flights), spaces.ts (which slides each address shows), page.ts (the page), handoff.ts (the cover that carries a slide into the viewer), mark.ts (the keyhole on a slide)
web/src/walker.ts       walking: capsule against the world collider and object hulls (three-mesh-bvh)
web/src/observe.ts      flagging: the overlay, the capture, the compare view, and the automation API (window.__wom.viewer with ?debug, which also saves slides)
web/src/observations.ts the Observations page; assetpanel.ts shows asset checks in the viewer and on the build page; viewcode.ts is the view link format
web/src/capture.ts      the flash and the card after a capture (name it, write a caption, see it in the slides, undo); the viewer saves the picture and the camera
packages/metrics/       @wom/metrics, the benchmark framework and the page that shows it (README.md inside)
  src/core/             the contract (tasks, runs, metrics) and the arithmetic: summaries, comparisons on shared cases, agreement
  src/node/             Benchmark, tasks and subjects, Spend (budget, cache, ledger), run store, reports, HTTP routes
  src/web/              the page (WOM: World Observation Metrics): tabs, charts, styles.css; analytics.ts holds every derived number
  examples/sums.ts      a whole benchmark in one file
```

## Notes

- API keys stay on the server. The browser only talks to the local WOM API, which binds to 127.0.0.1 by default.
- Photos are sent to Meta Model API in Standard mode, so they are not used for training. Muse Image runs with web search, image search and shell tools turned off.
- The native Tripo model IDs (`tripo-h31-image`, `tripo-p1-image`) currently finish at Tripo but AI3D rejects their output URLs ("untrusted_source"), and the job is still charged. WOM therefore uses the fal-hosted `tripo-v31` and `tripo-p1`.
- MoGe-3 and MoGe-2 place objects about equally well (backyard fitter IoU 0.82 with either). On the backyard photo MoGe-3 estimates a narrower field of view (72° against 80°) and puts far points closer (90th-percentile depth 8.2 m against 12.0 m). MoGe-3 has no `mask.png`; WOM takes valid pixels from its point map.
- IDOL runs in the `Synthetic` mode, which suits cutouts that are already isolated. It returns only the PLY, so IDOL objects have no preview image.
- Each IDOL or TripoSplat object is a 17.8 MB PLY, so a 4-object world loads about 71 MB of objects on top of the Marble splats.
- IDOL and TripoSplat rebuild whatever is in the cutout. If a mask fills the gaps in an object (for example, between bicycle spokes), the background seen through those gaps becomes part of the splat.
