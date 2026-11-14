import base64
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Always prepare the runtime-safe route pool before embedding the dataset. This
# keeps the generated HTML independent of expensive in-browser route planning.
subprocess.run([sys.executable, str(ROOT / "scripts/build_candidate_pool.py")], check=True)
template = (ROOT / "index.shell.html").read_text()
styles = (ROOT / "styles.css").read_text()
dataset = (ROOT / "data/tb2-mirror-40.js").read_text()
app = (ROOT / "app.js").read_text()
image_data = {
    "wood": "data:image/png;base64," + base64.b64encode((ROOT / "assets/tb2-12x12-mirror-wood.png").read_bytes()).decode("ascii"),
    "plastic": "data:image/png;base64," + base64.b64encode((ROOT / "assets/tb2-12x12-mirror-plastic.png").read_bytes()).decode("ascii"),
}

replacements = {
    "<!-- INLINE_STYLES -->": f"<style>\n{styles}\n</style>",
    "<!-- INLINE_DATA -->": f"<script>\n{dataset}\nwindow.CLIMBGEN_ASSETS = {json.dumps(image_data, separators=(',', ':'))};\n</script>",
    "<!-- INLINE_APP -->": f"<script>\n{app}\n</script>",
}
for marker, content in replacements.items():
    if template.count(marker) != 1:
        raise SystemExit(f"Expected exactly one {marker} marker in index.shell.html")
    template = template.replace(marker, content)

for output_name in ("index.html", "index.template.html", "index.source.html"):
    (ROOT / output_name).write_text(template)
print("Built self-contained index.html, index.template.html, and index.source.html")
