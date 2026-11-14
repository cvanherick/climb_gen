# ClimbGen beta

A simple one-button generator for a fixed 40° Tension Board 2 Mirror problem. ClimbGen has its own dark-and-lime interface; the board map uses the authentic TB2 Mirror hold artwork and public community climbs from the BoardLib dataset.

## Run locally

Open `index.html` directly in a modern browser. `index.template.html` and `index.source.html` are runnable copies as well. All three pages are self-contained, including styles, app code, TB2 data, and hold artwork. `index.shell.html` is the build source. After editing `app.js`, `styles.css`, data, or assets, run `python3 scripts/build_standalone.py` to regenerate the runnable pages.

## Dataset

`data/tb2-mirror-40.js` contains the 498 actual base-set placements in the selected 12 × 12 Mirror layout and 3,027 eligible 40° community climbs. The route slice keeps listed single-frame climbs with at least three ascents and a quality average of 2.4 or higher, then filters to routes whose holds all exist in the selected layout and have one or two starts, three to five middle holds, one finish, and one to four foot holds. The authentic transparent wood and plastic placement images are in `assets/`; the standalone builder embeds them along with the data so both pages work offline.

The database and placement images were downloaded using BoardLib’s documented public data flow. BoardLib extracts the bundled database from the Tension Board Android app and downloads layout images from the Board API; syncing newer rows requires a Tension account, so this bundled slice reflects the app database version available at acquisition time. See [BoardLib](https://github.com/lemeryfertitta/BoardLib).

The generator samples a route structure from that data, replaces one or two hand or foot placements with historically used nearby placements, rejects combinations already in the bundled route pool, and searches for a reachable hand sequence. If it cannot find a novel sequence, it falls back to a real community route and labels it accordingly.

The reach check is a simple 2D distance approximation. It does not model grip force, balance, collision, or a particular climber’s dimensions, so the sequence is a visualization of a possible beta rather than coaching advice.

## Deploy with GitHub Pages

The `.github/workflows/pages.yml` workflow builds the app and deploys it to GitHub Pages whenever a change is pushed to `main`. It can also be run manually from the repository’s Actions tab. The Pages build serves the app code, TB2 data, and board images as separate same-origin files; `python3 scripts/build_standalone.py` still creates a self-contained local copy.
