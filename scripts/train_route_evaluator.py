"""Train a compact TB2 grade and community-quality evaluator."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
FEATURE_NAMES = ["starts", "hands", "finishes", "feet", "handMeanX", "handMeanY", "handSpanX", "handSpanY", "routeMeanX", "routeMeanY", "routeSpanX", "routeSpanY", "handPairMean", "nearestMean", "finishProgress", "bboxDensity"]
GRADES = [f"V{i}" for i in range(12)]


def load_data():
    source = (ROOT / "data/tb2-mirror-40.js").read_text()
    start = source.index("window.CLIMBGEN_DATA = ") + len("window.CLIMBGEN_DATA = ")
    return json.JSONDecoder().raw_decode(source[start:])[0]


def features(route, placement_map):
    pts = [(placement_map.get(int(identifier)), int(role)) for identifier, role in route.get("holds", [])]
    pts = [(p, role) for p, role in pts if p]
    starts = [p for p, role in pts if role == 5]
    hands = [p for p, role in pts if role in (6, 7)]
    finishes = [p for p, role in pts if role == 7]
    feet = [p for p, role in pts if role == 8]
    active = [p for p, role in pts if role in (5, 6, 7)]

    def mean(items, key):
        return float(np.mean([p[key] for p in items])) if items else 0.0

    def span(items, key):
        vals = [p[key] for p in items]
        return float(max(vals) - min(vals)) if vals else 0.0

    pairwise = [float(np.hypot(a["x"] - b["x"], a["y"] - b["y"])) for i, a in enumerate(hands) for b in hands[i + 1:]]
    nearest = []
    for i, a in enumerate(hands):
        distances = [float(np.hypot(a["x"] - b["x"], a["y"] - b["y"])) for j, b in enumerate(hands) if i != j]
        if distances:
            nearest.append(min(distances))
    return [len(starts), len(hands), len(finishes), len(feet), mean(hands, "x"), mean(hands, "y"), span(hands, "x"), span(hands, "y"), mean(active, "x"), mean(active, "y"), span(active, "x"), span(active, "y"), float(np.mean(pairwise)) if pairwise else 0.0, float(np.mean(nearest)) if nearest else 0.0, mean(finishes, "y") - mean(starts, "y"), len(pts) / max(1.0, span(active, "x") * span(active, "y"))]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--epochs", type=int, default=1400)
    args = parser.parse_args()
    data = load_data()
    placements = {int(p["id"]): p for p in data["placements"]}
    routes = [r for r in data["routes"] if r.get("grade") in GRADES and r.get("quality") is not None and len(r.get("holds", [])) >= 3]
    x = np.asarray([features(r, placements) for r in routes], dtype=np.float64)
    y_grade = np.asarray([GRADES.index(r["grade"]) for r in routes], dtype=np.int64)
    y_quality = np.asarray([float(r["quality"]) for r in routes], dtype=np.float64)
    rng = np.random.default_rng(args.seed)
    order = rng.permutation(len(routes))
    split = max(1, int(len(routes) * 0.8))
    train, valid = order[:split], order[split:]
    mean = x[train].mean(axis=0)
    scale = x[train].std(axis=0)
    scale[scale < 1e-8] = 1.0
    z = (x - mean) / scale
    weights = np.sqrt(np.clip([float(r.get("ascents", 0)) for r in routes], 1, 2500))
    weights /= weights[train].mean()

    # Multiclass logistic regression trained with full-batch Adam.
    w = np.zeros((len(GRADES), x.shape[1]), dtype=np.float64)
    b = np.zeros(len(GRADES), dtype=np.float64)
    mw, vw, mb, vb = np.zeros_like(w), np.zeros_like(w), np.zeros_like(b), np.zeros_like(b)
    one_hot = np.eye(len(GRADES))[y_grade[train]]
    lr, reg = 0.025, 0.012
    for step in range(1, args.epochs + 1):
        logits = z[train] @ w.T + b
        logits -= logits.max(axis=1, keepdims=True)
        probs = np.exp(logits); probs /= probs.sum(axis=1, keepdims=True)
        delta = (probs - one_hot) * weights[train, None] / len(train)
        gw = delta.T @ z[train] + reg * w
        gb = delta.sum(axis=0)
        for grad, first, second, param in ((gw, mw, vw, w), (gb, mb, vb, b)):
            first *= 0.9; first += 0.1 * grad
            second *= 0.999; second += 0.001 * grad * grad
            param -= lr * (first / (1 - 0.9**step)) / (np.sqrt(second / (1 - 0.999**step)) + 1e-8)

    # Weighted ridge regression for the 1–5 community rating.
    design = np.column_stack((z[train], np.ones(len(train))))
    penalty = np.eye(design.shape[1]) * 0.2; penalty[-1, -1] = 0
    root_weight = np.sqrt(weights[train])
    coef = np.linalg.solve((design * root_weight[:, None]).T @ (design * root_weight[:, None]) + penalty, (design * root_weight[:, None]).T @ (y_quality[train] * root_weight))
    grade_valid_logits = z[valid] @ w.T + b
    grade_prob = np.exp(grade_valid_logits - grade_valid_logits.max(axis=1, keepdims=True))
    grade_prob /= grade_prob.sum(axis=1, keepdims=True)
    expected_grade = grade_prob @ np.arange(len(GRADES))
    quality_prediction = np.clip(z[valid] @ coef[:-1] + coef[-1], 1, 5)
    grade_prior = float(np.mean(y_grade[train]))
    quality_prior = float(np.mean(y_quality[train]))
    metrics = {
        "gradeExactAccuracy": float(np.mean(np.argmax(grade_prob, axis=1) == y_grade[valid])),
        "gradeMeanAbsoluteError": float(np.mean(np.abs(expected_grade - y_grade[valid]))),
        "gradePriorMeanAbsoluteError": float(np.mean(np.abs(grade_prior - y_grade[valid]))),
        "qualityMeanAbsoluteError": float(np.mean(np.abs(quality_prediction - y_quality[valid]))),
        "qualityPriorMeanAbsoluteError": float(np.mean(np.abs(quality_prior - y_quality[valid]))),
        "qualityLabelRange": [float(np.min(y_quality)), float(np.max(y_quality))],
        "validationRoutes": int(len(valid)),
    }
    model = {
        "featureNames": FEATURE_NAMES,
        "featureMean": mean.tolist(),
        "featureScale": scale.tolist(),
        "gradeLabels": GRADES,
        "gradeWeights": w.tolist(),
        "gradeBias": b.tolist(),
        "qualityWeights": coef[:-1].tolist(),
        "qualityBias": float(coef[-1]),
        "metadata": {"trainingRoutes": int(len(train)), "validationRoutes": int(len(valid)), "ratingsAreCommunityScores": True, "negativeExamples": "None. Bundled BoardLib slice is quality-filtered; this model only estimates ratings within that accepted pool and cannot reliably identify bad generated routes.", "metrics": metrics},
    }
    script = "window.CLIMBGEN_ROUTE_EVALUATOR = " + json.dumps(model, separators=(",", ":")) + ";\n"
    out = ROOT / "data/tb2-route-evaluator.js"
    out.write_text(script)
    print(json.dumps({"output": str(out), "trainingRoutes": len(train), "validationRoutes": len(valid), "gradeCounts": {grade: int(np.sum(y_grade[train] == i)) for i, grade in enumerate(GRADES)}, "metrics": metrics}, indent=2))


if __name__ == "__main__":
    main()
