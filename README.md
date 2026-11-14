# ClimbGen beta

A simple climb generator for a fixed 40° Tension Board 2 Mirror problem. Choose a grade from V0 to V11 or leave it on Any. ClimbGen has its own dark-and-lime interface; the board map uses the authentic TB2 Mirror hold artwork and public community climbs from the BoardLib dataset.

## Run locally

Run `python3 scripts/build_standalone.py` to create self-contained `index.html`, `index.template.html`, and `index.source.html` files, then open `index.html` in a modern browser. `index.shell.html` is the shared build source. After editing the app, styles, data, or assets, rerun the standalone builder.

## Dataset

`data/tb2-mirror-40.js` contains the 498 actual base-set placements in the selected 12 × 12 Mirror layout and 3,027 eligible 40° community climbs. The route slice keeps listed single-frame climbs with at least three ascents and a quality average of 2.4 or higher, then filters to routes whose holds all exist in the selected layout and have one or two starts, three to five middle holds, one finish, and one to four foot holds. The authentic transparent wood and plastic placement images are in `assets/`; the standalone builder embeds them along with the data so both pages work offline.

The database and placement images were downloaded using BoardLib’s documented public data flow. BoardLib extracts the bundled database from the Tension Board Android app and downloads layout images from the Board API; syncing newer rows requires a Tension account, so this bundled slice reflects the app database version available at acquisition time. See [BoardLib](https://github.com/lemeryfertitta/BoardLib).

## Grade-conditioned diffusion model

`scripts/train_diffusion.py` trains a PyTorch denoising diffusion model on the labeled TB2 40° community climbs. Each training example represents the board as four hold-role channels (start, hand, finish, and foot), and a learned grade embedding conditions denoising on V0–V11. The classifier-free grade guidance sampler generates new role grids; projected hold sets are then checked for route novelty and a reachable hand sequence. This produces a ready-to-use, grade-balanced browser pool in `data/tb2-mirror-40.js` and saves the trained checkpoint to `models/tb2-grade-diffusion.pt`.

To retrain and refresh the app pool, install PyTorch and NumPy, then run `python3 scripts/train_diffusion.py --epochs 50`. To change the sampling volume, pass `--samples-per-grade N`. The GitHub Pages build uses the prepared pool and does not need PyTorch or retrain during deployment.

The reach check is a simple 2D distance approximation. It does not model grip force, balance, collision, or a particular climber’s dimensions, so the sequence is a visualization of a possible beta rather than coaching advice. For grades where the sampler yields too few novel reachable routes, the pool is topped up with distinct reachable TB2 routes of the requested grade; these remain labeled as dataset routes in the app data.

## Deploy with GitHub Pages

The `.github/workflows/pages.yml` workflow builds the app and deploys it to GitHub Pages whenever a change is pushed to `main`. It can also be run manually from the repository’s Actions tab. `scripts/build_pages.py` serves the app code, TB2 data, and board images as separate same-origin files. Use `python3 -m http.server` to preview that build locally; `scripts/build_standalone.py` makes offline copies instead.

## Climb names and beta animation

The name entered in the app is the route title and a deterministic seed for selecting from the prepared grade-conditioned model samples. The browser avoids repeats until it has used the selected grade’s prepared pool. The bundled BoardLib route rows do not contain climb names, so name text does not have learned semantic meaning yet. Retraining on a dataset with route names would be needed for text-guided holds.

“Reveal beta animation” searches a contact sequence through the route’s hand and foot holds. It draws a two-dimensional climber over the authentic TB2 Mirror board image, solves two-segment arm and leg poses, and keeps planted contacts fixed while the moving limb swings. The feasibility badge reports joint reach limits and contact drift; this model remains a board-plane visualization, not a full-body physics simulation.
