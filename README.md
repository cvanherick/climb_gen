# ClimbGen beta

A simple climb generator for a fixed 40° Tension Board 2 Mirror problem. Choose a grade from V0 to V11 or leave it on Any. ClimbGen has its own dark-and-lime interface; the board map uses the authentic TB2 Mirror hold artwork and public community climbs from the BoardLib dataset.

## Run locally

Run `python3 scripts/build_standalone.py` to create self-contained `index.html`, `index.template.html`, and `index.source.html` files, then open `index.html` in a modern browser. `index.shell.html` is the shared build source. After editing the app, styles, data, or assets, rerun the standalone builder.

## Dataset

`data/tb2-mirror-40.js` contains the 498 actual base-set placements in the selected 12 × 12 Mirror layout and 3,027 eligible 40° community climbs. The route slice keeps listed single-frame climbs with at least three ascents and a quality average of 2.4 or higher, then filters to routes whose holds all exist in the selected layout and have one or two starts, three to five middle holds, one finish, and one to four foot holds. The authentic transparent wood and plastic placement images are in `assets/`; the standalone builder embeds them along with the data so both pages work offline.

The database and placement images were downloaded using BoardLib’s documented public data flow. BoardLib extracts the bundled database from the Tension Board Android app and downloads layout images from the Board API; syncing newer rows requires a Tension account, so this bundled slice reflects the app database version available at acquisition time. See [BoardLib](https://github.com/lemeryfertitta/BoardLib).

## On-demand climb generation

The browser now generates a new climb variant on every click rather than cycling through the 120-row prepared pool. `route_generator.js` selects a well-rated route template for the requested grade, keeps every start hold in the board's lower third (`y ≤ 44`), changes one to three hand or foot contacts using TB2 community hold frequencies, then checks upward progress, reachability, vertical spread, and isolated holds. Before displaying a route, the app also requires the four-limb beta planner to find a contact sequence; it retries other variants when a candidate fails. Quality-checked DDPM samples can also seed variants. It avoids repeats during the current page session. The possible combinations are very large but finite because the board has a fixed hold set.

`scripts/train_diffusion.py` trains the offline grade-conditioned DDPM from TB2 routes labeled V0–V11. Each route's grade is supplied to a learned grade embedding during denoising training; the model also receives classifier-free grade dropout so sampling can apply explicit target-grade guidance. The train/validation split is stratified by grade, underrepresented grades receive inverse-square-root sampling weight, and checkpoint selection uses macro-averaged per-grade validation loss. Sampling requests the selected grade, then rejects candidates that fail the same start, progress, spacing, and reachability checks used by the app. The browser does not need PyTorch or a backend: the fresh checkpoint's screened samples are bundled as grade-specific seeds, and on-demand variations draw replacement holds only from that same grade's TB2 statistics. The grade shown in the UI is the requested dataset grade, not a calibrated prediction of how difficult a person will find the climb; community grade labels are subjective and sparse for some grades.

The generator reports an explicit error if it cannot find a new screened variant after its bounded attempts. Route checks are geometric filters, not a learned grade-quality model or real-world safety test.

## Deploy with GitHub Pages

The `.github/workflows/pages.yml` workflow builds the app and deploys it to GitHub Pages whenever a change is pushed to `main`. It can also be run manually from the repository’s Actions tab. `scripts/build_pages.py` serves the app code, TB2 data, and board images as separate same-origin files. Use `python3 -m http.server` to preview that build locally; `scripts/build_standalone.py` makes offline copies instead.

## Climb names and beta planning

The name entered in the app is the route title and one input to a per-session random seed. It does not have learned semantic meaning: the bundled BoardLib route rows do not contain climb names. Retraining on a dataset with route names would be needed for text-guided holds.

“Reveal beta animation” runs a bounded beam search over left and right hand and foot contacts. Each node includes the four contacts and a torso pose. The objective combines limb reach, joint-angle awkwardness, approximate support, body movement, repeated-limb moves, and move count; weights can be overridden through the planner API's `options.weights`. The planner supports hand matches, foot swaps, cross-through reaches, and high, lateral, or downward foot repositioning. It may return an explicit no-plan result when the search budget expires or it cannot satisfy the modeled reach constraints; it never substitutes the candidate's precomputed hand sequence.

`ik.js` contains the configurable body dimensions and two-bone IK solver. Reachable link lengths are solved exactly. The optimizer estimates torso position, joint angles, center of mass, and a support polygon; the 40° overhang scales a heuristic penalty only. `planner.js` is independent of the page DOM and yields between expanded states. The animation uses `requestAnimationFrame`, solves each moving limb against a temporary interpolated contact, and keeps the other contact endpoints planted.

The result panel separates modeled kinematic checks from the approximate support score and states that physical feasibility is unverified. Debug details are hidden by default; open “Planner diagnostics” to view explored states, rejected transitions, timing, weighted cost, center of mass, and support hull. Playback includes pause, replay, and speed controls.

## Build a climb from a wall photo

The experimental photo builder keeps an uploaded wall image in the browser session. On upload, `photo_hold_detector.js` combines photo-local color regions and local Lab-contrast regions, cleans small pixel specks, scores region size/shape/border contrast/color consistency, and suppresses duplicate candidates. It highlights detections with solid, hold-sized circles instead of boxes and labels. Marking the wall's four corners masks the photo to the wall and automatically reruns detection inside it, avoiding foliage, mats, and supports outside the climbing surface. Users can remove false marks, add missed holds, select a start, and choose among ranked next-hold options, including a possible finish. This remains an experimental image-segmentation heuristic, not a trained hold model; it can merge same-colored adjacent holds or miss shadowed/textured holds. Suggestions use corrected hold coordinates and TB2 community-route movement geometry as a prior. A single image does not establish physical wall angle or scale; angle input is optional and user supplied. Suggestions are not photo-conditioned diffusion and do not verify reachability or safety. `photo_suggestions.js` and `photo_hold_detector.js` are loaded by both Pages and standalone builds.

There are public image datasets that could seed a hold detector, but their rights need to be checked at the image-source level. The [Crimps Bouldering Holds dataset](https://universe.roboflow.com/crimps/bouldering-holds-rpoux) states CC BY 4.0 for its 427-image version; retain attribution and confirm export/model redistribution terms before bundling a trained model. [ClimbInst](https://huggingface.co/datasets/ClimbVision/ClimbInst) has more annotations, but defers to the licenses of its constituent image sources. Do not treat arbitrary web images or videos as training data simply because they are publicly viewable; [YouTube's developer policies](https://developers.google.com/youtube/terms/developer-policies/) prohibit scraping and downloading or storing audiovisual copies without prior written approval.

### Reproducible evaluation

Run `node --test tests/planner.test.js` for IK, deterministic route, and explicit failure tests. Run `node scripts/evaluate_planner.js` to benchmark a deterministic stratified sample (indices 0, 11, 22, …, 111) spanning V0–V11. On the current local run, the planner found a contact plan for 11 of 12 routes, with an average of 8.7 contact actions and 29 foot moves across those 11 plans. Search time ranged from a few milliseconds to 1.57 seconds on this machine. One case returned no plan within the configured model/search limits.

The evaluation also records the previous approach's prewritten hand-move count and simple hand-to-hand reach excursions. That baseline had 19 moves over a 36 board-unit point-to-point reach threshold across the same 12 routes. This is only a diagnostic of the old fixed sequence, not a learned or hand-labeled beta-quality benchmark. No ground-truth contact sequences are available in the bundled community rows, so these results do not establish that the new sequences match expert beta or are safe to climb.

### Limits and next research step

This remains a 2D geometric animation. The support-polygon score does not estimate forces, friction, grip strength, wall collisions, or real-world fall risk. The search state stores torso pose, but equivalent contact/visited states are canonicalized during pruning to control runtime. Explicit foot flags, temporary unweighting, force transfer, and 3D cross-through motion are not modeled. Names remain titles and deterministic route-pool seeds, not learned text conditioning.

### Motion-data direction

[ClimbingCap / AscendMotion](https://openaccess.thecvf.com/content/CVPR2025/html/Yan_ClimbingCap_Multi-Modal_Dataset_and_Method_for_Rock_Climbing_in_World_CVPR_2025_paper.html) is a possible future source for a learned movement prior. It is not integrated here; the next useful research milestone is to hand-label plausible four-limb sequences for a small TB2 route set and compare the geometric planner against those annotations before adding a learned motion model.

`scripts/prepare_motion_data.py` is a provenance-gated adapter for owner-permitted pose/contact annotations. It requires an explicit training permission flag and records dataset/license provenance. See [the motion-data schema](docs/motion-data-schema.md). It does not download videos, infer contacts, or establish dataset rights.
