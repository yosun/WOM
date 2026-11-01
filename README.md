# World of a Memory (WOM)

WOM turns one photo into an explorable 3D world. The viewer opens on the original photo while the world loads behind it, framed by the camera WOM reconstructed. When the world is ready, a play-button-shaped portal opens onto it. Press *Enter the world* and the photo gives way to the 3D scene, which you walk through with W A S D.

## How a photo becomes a world

| Step | Model | What it does |
| --- | --- | --- |
| Scene plan | **Muse Spark 1.3** (or Muse Wonder 1.0) | Reads the photo and picks the objects to rebuild as separate 3D objects. For each object it returns a box, a point inside it and a short description. It also writes the object-removal instruction and the prompt for the surrounding world. |
| Segmentation | **SAM 3.1** (Meta Model API) + Muse Spark review | Runs a box+point prompt and a concept prompt for every object. Concept prompts capture foliage and spokes; box prompts handle solid objects. When both give plausible masks, Muse Spark rates the cutouts and the cleaner one wins. |
| Clean plate | **Muse Image** + Muse Spark review | Erases the chosen objects and their shadows. Muse Spark checks the edit and asks for another pass if anything is left. |
| Depth | **MoGe-2** on AI3D | Produces a metric point map of the photo (for placing objects) and of the clean plate (for the background relief). |
| Cutouts | SAM masks + **Muse Image** | Cuts each object out with its mask. Objects that are occluded or cut off by the frame are completed by Muse Image. |
| Objects | **TripoSplat** on AI3D (`triposplat`, default) | Turns each cutout into a Gaussian-splat object (PLY, 262k splats). Splats keep the photo's look, including fur and leaves. Textured meshes from Tripo H3.1 (`tripo-v31`) or Tripo P1 (`tripo-p1`) are still available under *Settings*. |
| Surrounding world | **World Labs Marble 1.1** on AI3D | Generates a Gaussian-splat world from the clean plate plus Muse Spark's world prompt. |
| Compose | Local (Node) | Calibrates Marble's camera against the photo, fits each object into place, builds the depth relief, and writes `scene.json`. |

### Placement ("compose")

- **Marble calibration.** Marble keeps the input camera at the origin of its raw OpenCV-style frame but uses its own field of view and units. WOM renders the splats from the origin and searches field of view, pitch, yaw and roll until they match the clean plate. Metric scale is the median ratio of MoGe depth to splat depth.
- **Object fitting.** A CPU rasterizer renders each object and fits scale, image position, yaw and pitch so its silhouette matches the SAM mask. Pixels hidden by something closer in the MoGe depth map are not penalized, and neither are parts beyond the image border. Finally the object slides along the camera ray until its visible surface matches MoGe's metric depth. Moving along the ray cannot change the silhouette, so this step keeps the fit.
  - Tripo meshes start facing the camera along their viewing ray, which is what `align_image` produces.
  - TripoSplat objects come out with −Y up but with no fixed facing, so the fitter searches the full circle of yaw. Splats are drawn as discs 1.5× the geometric mean of their two largest axes. That size reproduces Spark's on-screen silhouette at IoU 0.92–0.98; larger discs made every object come out 5–14% too small.
- **Check.** Compose writes `reprojection.jpg`, the reconstruction rendered from the photo's camera, so you can compare it with the photo.

## Run it

Requirements: Node 22.18+ (Node runs the TypeScript server directly) and API keys for the Meta Model API and AI3D.

```bash
cp .env.example .env     # then fill in MUSE_API_KEY and AI3D_API_KEY
npm install
npm run dev              # API on :8787, web app on http://localhost:5173
```

For a single-process build: `npm start`, then open http://127.0.0.1:8787.

`node --env-file=.env scripts/make-sample.ts samples/backyard.png` generates a sample photo with Muse Image ($0.01).

## Cost per world (measured)

A 4-object outdoor photo with Marble 1.1 and TripoSplat objects costs **$1.72**:

- Muse Spark plan, SAM 3.1, clean plate, review and one completion: $0.06
- MoGe-2 ×2: $0.20
- TripoSplat ×4: $0.20
- Marble 1.1: $1.26

Objects cost $0.05 each with TripoSplat, $0.30 with Tripo H3.1 (`tripo-v31`) and $0.50 with Tripo P1. Without a Marble world, a 2-object portrait costs $0.36. Marble draft (`worldlabs-draft`) costs about $0.18 instead of $1.26. Every charge is listed on the world's build page.

Finished steps are never re-run: retrying a world reuses paid outputs and resumes AI3D jobs that were already submitted. If you change the object model and retry, only the objects are regenerated.

## Using the viewer

1. **The memory.** The photo appears at once, framed exactly like the reconstructed camera, with a progress bar while the world loads behind it. A photo whose shape is close to the screen's fills the screen; other photos are shown whole on a blurred copy of themselves.
2. **The portal.** Once everything has loaded, the photo dims and a play-button-shaped hole opens onto the live 3D world. The view inside drifts slightly, so you can see it is 3D.
3. **Inside.** Click *Enter the world*, click the hole or press Enter. The hole grows until the photo is gone. Then:
   - W A S D (or the arrow keys) walk, Shift runs, Q / E go down and up, and the scroll wheel glides forward and back. These are Spark's `SparkControls`. Walking stays level unless you press Q / E.
   - Drag to look around.
   - *Back to the memory* (P) flies back to the photo's viewpoint and reopens the portal.
   - *Layers* holds the Marble world (with a choice of splat resolution), the MoGe-2 depth relief and the objects.
   - *Edit layout* lets you click an object and move, rotate or scale it (G / R / T). *Save layout* keeps your changes and *Reset* restores the fitted poses.
   - *Export meshes (GLB)* downloads the mesh objects and the relief. Splat objects are not included.

## Project layout

```
server/src/
  index.ts              HTTP API, SSE progress, artifact files
  store.ts              worlds on disk (data/worlds/<id>/manifest.json + artifacts)
  clients/meta.ts       Muse Spark/Wonder chat, SAM 3.1, Muse Image
  clients/ai3d.ts       AI3D uploads, jobs, artifacts
  pipeline/run.ts       orchestration, resume and retry
  pipeline/*.ts         analyze, segment, cleanplate, cutouts, generate (MoGe/Tripo/Marble), compose
  geometry/*.ts         EXR/SPZ/PLY/GLB loading, rasterizer, pose fitting, Marble calibration, relief mesh
web/src/                home, build progress and viewer (three.js + Spark)
```

## Notes

- API keys stay on the server. The browser only talks to the local WOM API, which binds to 127.0.0.1 by default.
- Photos are sent to Meta Model API in Standard mode, so they are not used for training. Muse Image runs with web search, image search and shell tools turned off.
- The native Tripo model IDs (`tripo-h31-image`, `tripo-p1-image`) currently finish at Tripo but AI3D rejects their output URLs ("untrusted_source"), and the job is still charged. WOM therefore uses the fal-hosted `tripo-v31` and `tripo-p1`.
- MoGe-3 is not in the AI3D catalog yet; WOM uses MoGe-2.
- Each TripoSplat object is a 17.8 MB PLY, so a 4-object world loads about 71 MB of objects on top of the Marble splats.
- TripoSplat rebuilds whatever is in the cutout. If a mask fills the gaps in an object (for example, between bicycle spokes), the background seen through those gaps becomes part of the splat.
