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
route_evaluator_data_path = ROOT / "data/tb2-route-evaluator.js"
profiles_path = ROOT / "data/tb2-hold-profiles.js"
hold_profiles_path = ROOT / "hold_profiles.js"
app_path = ROOT / "app.js"
animation_path = ROOT / "animation.js"
ik_path = ROOT / "ik.js"
planner_path = ROOT / "planner.js"
route_generator_path = ROOT / "route_generator.js"
route_evaluator_path = ROOT / "route_evaluator.js"
photo_suggestions_path = ROOT / "photo_suggestions.js"
photo_hold_detector_path = ROOT / "photo_hold_detector.js"
style_path = ROOT / "styles.css"
replacements = {
    "<!-- INLINE_STYLES -->": f'<link rel="stylesheet" href="./styles.css?v={cache_version(style_path)}" />',
    "<!-- INLINE_DATA -->": (
        f'<script src="./data/tb2-hold-profiles.js?v={cache_version(profiles_path)}"></script>'
        f'<script src="./data/tb2-mirror-40.js?v={cache_version(data_path)}"></script>'
        f'<script src="./data/tb2-route-evaluator.js?v={cache_version(route_evaluator_data_path)}"></script>'
    ),
    "<!-- INLINE_MODELS -->": (
        f'<script src="./hold_profiles.js?v={cache_version(hold_profiles_path)}"></script>'
        f'<script src="./route_evaluator.js?v={cache_version(route_evaluator_path)}"></script>'
        f'<script src="./route_generator.js?v={cache_version(route_generator_path)}"></script>'
        f'<script src="./ik.js?v={cache_version(ik_path)}"></script>'
        f'<script src="./animation.js?v={cache_version(animation_path)}"></script>'
        f'<script src="./planner.js?v={cache_version(planner_path)}"></script>'
        f'<script src="./photo_suggestions.js?v={cache_version(photo_suggestions_path)}"></script>'
        f'<script src="./photo_hold_detector.js?v={cache_version(photo_hold_detector_path)}"></script>'
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
for name in ("animation.js", "hold_profiles.js", "app.js", "route_evaluator.js", "route_generator.js", "ik.js", "planner.js", "photo_suggestions.js", "photo_hold_detector.js", "styles.css"):
    shutil.copy2(ROOT / name, DIST / name)
shutil.copy2(ROOT / "data/tb2-mirror-40.js", DIST / "data/tb2-mirror-40.js")
shutil.copy2(route_evaluator_data_path, DIST / "data/tb2-route-evaluator.js")
for image in (ROOT / "assets").glob("tb2-12x12-mirror-*.png"):
    shutil.copy2(image, DIST / "assets" / image.name)
shutil.copy2(ROOT / "index.html", DIST / "index.html")
print("Built Pages app with separate JavaScript, TB2 data, and image assets")

shutil.copy2(profiles_path, DIST / "data/tb2-hold-profiles.js")
shutil.copy2(ROOT / "assets/tb2-hold-crops-atlas.webp", DIST / "assets/tb2-hold-crops-atlas.webp")

shutil.copytree(ROOT / "docs/hold-references", DIST / "docs/hold-references")
