"""Build approximate TB2 hold meshes from placed silhouettes in the app's board art."""
import json
import math
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def load_script(path):
    return json.loads((ROOT / path).read_text().split("=", 1)[1].strip().rstrip(";"))


def footprint(image, labels, stats, label, anchor):
    x, y, width, height, _ = stats[label]
    ys, xs = np.where(labels[y:y + height, x:x + width] == label)
    color = np.median(image[ys + y, xs + x, :3], axis=0)[::-1]
    color = np.clip(color * 0.85 + (9, 8, 6), 38, 222).astype(int).tolist()
    # The SVG board art spans these board coordinates, while the panel is 144 in wide.
    pixels = np.column_stack((xs + x, ys + y))
    world = (pixels - anchor) * [136 / image.shape[1], -144 / image.shape[0]]
    hull = cv2.convexHull(world.astype("float32"))
    hull = cv2.approxPolyDP(hull, 0.14, True).reshape(-1, 2).tolist()
    minor = min(cv2.minAreaRect(world.astype("float32"))[1])
    return {"depth": round(float(np.clip(0.45 * minor, 0.55, 3.1)), 2),
            "outline": [[round(x, 2), round(y, 2)] for x, y in hull], "color": color}


def main():
    placements = load_script("data/tb2-mirror-40.js")["placements"]
    catalog = load_script("data/tb2-hold-spectrum.js")["holds"]
    meshes = {}
    missing = []
    for material in ("wood", "plastic"):
        image = cv2.imread(str(ROOT / f"assets/tb2-12x12-mirror-{material}.png"), cv2.IMREAD_UNCHANGED)
        alpha = 128 if material == "wood" else 195
        _, labels, stats, centers = cv2.connectedComponentsWithStats((image[:, :, 3] > alpha).astype("uint8"))
        components = np.where((stats[:, 4] > 18) & (stats[:, 4] < 5000))[0]
        used = set()
        for hold in placements:
            if hold["set"].lower() != material:
                continue
            anchor = np.array([(hold["x"] + 68) * image.shape[1] / 136,
                               (144 - hold["y"]) * image.shape[0] / 144])
            distances = np.linalg.norm(centers[components] - anchor, axis=1)
            nearest = int(components[distances.argmin()])
            if distances.min() > 12 or nearest in used:
                missing.append(str(hold["id"]))
                continue
            used.add(nearest)
            meshes[str(hold["id"])] = footprint(image, labels, stats, nearest, anchor)

    compass = {name: i * math.tau / 16 for i, name in enumerate(
        "E ENE NE NNE N NNW NW WNW W WSW SW SSW S SSE SE ESE".split())}
    # Reuse the matching official shape from a clear installation when its
    # silhouette cannot be matched, rotating it by the printed direction marker.
    for id in missing:
        hold = catalog[id]
        source_id = next(key for key in meshes if catalog[key]["shape"] == hold["shape"]
                         and catalog[key]["material"] == hold["material"])
        source = meshes[source_id]
        angle = compass[hold["installationMarker"]] - compass[catalog[source_id]["installationMarker"]]
        c, s = math.cos(angle), math.sin(angle)
        meshes[id] = {**source, "outline": [[round(x*c - y*s, 2), round(x*s + y*c, 2)]
                                             for x, y in source["outline"]], "rotatedFrom": int(source_id)}
    assert len(meshes) == len(placements)
    data = {"layoutId": 10, "depthsEstimated": True, "holds": meshes}
    (ROOT / "data/tb2-hold-geometry.js").write_text(
        "globalThis.CLIMBGEN_HOLD_GEOMETRY = " + json.dumps(data, separators=(",", ":")) + ";\n")
    print(f"Reconstructed {len(meshes)} hold footprints ({len(missing)} rotated from matching shapes).")


if __name__ == "__main__":
    main()
