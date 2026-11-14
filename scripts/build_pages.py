import json
import hashlib
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
def cache_version(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]

data_path = ROOT / "data/tb2-mirror-40.js"
app_path = ROOT / "app.js"
style_path = ROOT / "styles.css"
replacements = {
    "<!-- INLINE_STYLES -->": f'<link rel="stylesheet" href="./styles.css?v={cache_version(style_path)}" />',
    "<!-- INLINE_DATA -->": (
        f'<script src="./data/tb2-mirror-40.js?v={cache_version(data_path)}"></script>'
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
for name in ("app.js", "styles.css"):
    shutil.copy2(ROOT / name, DIST / name)
shutil.copy2(ROOT / "data/tb2-mirror-40.js", DIST / "data/tb2-mirror-40.js")
for image in (ROOT / "assets").glob("tb2-12x12-mirror-*.png"):
    shutil.copy2(image, DIST / "assets" / image.name)
shutil.copy2(ROOT / "index.html", DIST / "index.html")
print("Built Pages app with separate JavaScript, TB2 data, and image assets")
