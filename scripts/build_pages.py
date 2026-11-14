import json
import hashlib
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"

# Keep the large TB2 data and board images as separate same-origin resources.
# The grade-conditioned model pool is prepared by train_diffusion.py.

html = (ROOT / "index.shell.html").read_text()
def cache_version(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]

data_path = ROOT / "data/tb2-mirror-40.js"
app_path = ROOT / "app.js"
ik_path = ROOT / "ik.js"
planner_path = ROOT / "planner.js"
route_generator_path = ROOT / "route_generator.js"
photo_suggestions_path = ROOT / "photo_suggestions.js"
style_path = ROOT / "styles.css"
replacements = {
    "<!-- INLINE_STYLES -->": f'<link rel="stylesheet" href="./styles.css?v={cache_version(style_path)}" />',
    "<!-- INLINE_DATA -->": (
        f'<script src="./data/tb2-mirror-40.js?v={cache_version(data_path)}"></script>'
    ),
    "<!-- INLINE_MODELS -->": (
        f'<script src="./route_generator.js?v={cache_version(route_generator_path)}"></script>'
        f'<script src="./ik.js?v={cache_version(ik_path)}"></script>'
        f'<script src="./planner.js?v={cache_version(planner_path)}"></script>'
        f'<script src="./photo_suggestions.js?v={cache_version(photo_suggestions_path)}"></script>'
    ),
    "<!-- INLINE_APP -->": f'<script src="./app.js?v={cache_version(app_path)}"></script>',
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
for name in ("app.js", "route_generator.js", "ik.js", "planner.js", "photo_suggestions.js", "styles.css"):
    shutil.copy2(ROOT / name, DIST / name)
shutil.copy2(ROOT / "data/tb2-mirror-40.js", DIST / "data/tb2-mirror-40.js")
for image in (ROOT / "assets").glob("tb2-12x12-mirror-*.png"):
    shutil.copy2(image, DIST / "assets" / image.name)
shutil.copy2(ROOT / "index.html", DIST / "index.html")
print("Built Pages app with separate JavaScript, TB2 data, and image assets")
