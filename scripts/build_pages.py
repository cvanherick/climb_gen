import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"

# Keep the large TB2 data and board images as separate same-origin resources.
# This avoids an oversized inline script in the deployed page while retaining
# the self-contained local build produced by build_standalone.py.
subprocess.run([sys.executable, str(ROOT / "scripts/build_candidate_pool.py")], check=True)

html = (ROOT / "index.shell.html").read_text()
replacements = {
    "<!-- INLINE_STYLES -->": '<link rel="stylesheet" href="./styles.css" />',
    "<!-- INLINE_DATA -->": (
        '<script>window.addEventListener("error", event => '
        '{ window.CLIMBGEN_LOAD_ERROR = event.message || "script load error"; });</script>\n'
        '<script src="./data/tb2-mirror-40.js"></script>\n'
        '<script>window.CLIMBGEN_ASSETS = '
        '{"wood":"./assets/tb2-12x12-mirror-wood.png",'
        '"plastic":"./assets/tb2-12x12-mirror-plastic.png"};</script>'
    ),
    "<!-- INLINE_APP -->": '<script src="./app.js"></script>',
}
for marker, content in replacements.items():
    if html.count(marker) != 1:
        raise SystemExit(f"Expected exactly one {marker} marker in index.shell.html")
    html = html.replace(marker, content)

(ROOT / "index.html").write_text(html)
if DIST.exists():
    shutil.rmtree(DIST)
(DIST / "data").mkdir(parents=True)
(DIST / "assets").mkdir()
for name in ("app.js", "styles.css"):
    shutil.copy2(ROOT / name, DIST / name)
shutil.copy2(ROOT / "data/tb2-mirror-40.js", DIST / "data/tb2-mirror-40.js")
for image in (ROOT / "assets").glob("tb2-12x12-mirror-*.png"):
    shutil.copy2(image, DIST / "assets" / image.name)
shutil.copy2(ROOT / "index.html", DIST / "index.html")
print("Built Pages app with separate JavaScript, TB2 data, and image assets")
