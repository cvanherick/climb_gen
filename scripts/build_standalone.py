import base64
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
template = (ROOT / "index.shell.html").read_text()
styles = (ROOT / "styles.css").read_text()
dataset = (ROOT / "data/tb2-mirror-40.js").read_text()
app = (ROOT / "app.js").read_text()
models = (ROOT / "ik.js").read_text() + "\n" + (ROOT / "planner.js").read_text()
route_generator = (ROOT / "route_generator.js").read_text()
photo_suggestions = (ROOT / "photo_suggestions.js").read_text()
photo_hold_detector = (ROOT / "photo_hold_detector.js").read_text()
image_data = {
    "wood": "data:image/png;base64," + base64.b64encode((ROOT / "assets/tb2-12x12-mirror-wood.png").read_bytes()).decode("ascii"),
    "plastic": "data:image/png;base64," + base64.b64encode((ROOT / "assets/tb2-12x12-mirror-plastic.png").read_bytes()).decode("ascii"),
}

replacements = {
    "<!-- INLINE_STYLES -->": f"<style>\n{styles}\n</style>",
    "<!-- INLINE_DATA -->": f"<script>\n{dataset}\nwindow.CLIMBGEN_ASSETS = {json.dumps(image_data, separators=(',', ':'))};\n</script>",
    "<!-- INLINE_MODELS -->": f"<script>\n{route_generator}\n{models}\n{photo_suggestions}\n{photo_hold_detector}\n</script>",
    "<!-- INLINE_APP -->": f"<script>\n{app}\n</script>",
}
for marker, content in replacements.items():
    if template.count(marker) != 1:
        raise SystemExit(f"Expected exactly one {marker} marker in index.shell.html")
    template = template.replace(marker, content)

for output_name in ("index.html", "index.template.html", "index.source.html"):
    (ROOT / output_name).write_text(template)
print("Built self-contained index.html, index.template.html, and index.source.html")
