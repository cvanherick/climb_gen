import json
import math
import random
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
data_path = ROOT / "data/tb2-mirror-40.js"
source = data_path.read_text().strip()
prefix = "window.CLIMBGEN_DATA = "
if not source.startswith(prefix) or not source.endswith(";"):
    raise SystemExit("Unexpected TB2 data wrapper")
data = json.loads(source[len(prefix):-1])
positions = {int(hold["id"]): hold for hold in data["placements"]}


def signature(holds):
    return "|".join(sorted(f"{hold[0]}r{hold[1]}" for hold in holds))


def distance(a, b):
    aa, bb = positions[int(a)], positions[int(b)]
    return math.hypot(aa["x"] - bb["x"], aa["y"] - bb["y"])


def plan(holds):
    starts = sorted((hold[0] for hold in holds if hold[1] == 5), key=lambda i: positions[int(i)]["x"])
    middle = [hold[0] for hold in holds if hold[1] == 6]
    finishes = [hold[0] for hold in holds if hold[1] == 7]
    if not starts or not middle or not finishes:
        return None
    left, right = int(starts[0]), int(starts[-1] if len(starts) > 1 else starts[0])
    reach = 43
    best = [None]

    def visit(left_id, right_id, remaining, path, cost, previous_side):
        if not remaining:
            for finish in finishes:
                for side, limb, origin in (("left", "L hand", left_id), ("right", "R hand", right_id)):
                    d = distance(origin, finish)
                    if d <= reach:
                        total = cost + d + (5 if side == previous_side else 0)
                        if best[0] is None or total < best[0][0]:
                            best[0] = (total, path + [{"id": int(finish), "limb": limb, "role": 7}])
            return
        if best[0] is not None and cost >= best[0][0]:
            return
        for raw_id in remaining:
            hold_id = int(raw_id)
            options = []
            for side, limb, origin in (("left", "L hand", left_id), ("right", "R hand", right_id)):
                d = distance(origin, hold_id)
                if d <= reach:
                    options.append((d, side, limb))
            options.sort()
            for d, side, limb in options:
                visit(
                    hold_id if side == "left" else left_id,
                    hold_id if side == "right" else right_id,
                    [other for other in remaining if int(other) != hold_id],
                    path + [{"id": hold_id, "limb": limb, "role": 6}],
                    cost + d + (5 if side == previous_side else 0),
                    side,
                )

    visit(left, right, middle, [], 0, None)
    return best[0][1] if best[0] else None


rng = random.Random(180)
known = {signature(route["holds"]) for route in data["routes"]}
weights = {6: Counter(), 8: Counter()}
for route in data["routes"]:
    for hold_id, role in route["holds"]:
        if role in weights:
            weights[role][int(hold_id)] += 1
role_pool = {role: list(counter.items()) for role, counter in weights.items()}


def replacement(role, old_id, used):
    candidates = []
    for hold_id, weight in role_pool[role]:
        if hold_id in used:
            continue
        d = distance(old_id, hold_id)
        if 4 <= d <= 25:
            candidates.append((hold_id, weight / (1 + d / 12), d))
    candidates.sort(key=lambda row: row[2])
    candidates = candidates[:80]
    if not candidates:
        return None
    return rng.choices(candidates, weights=[row[1] for row in candidates], k=1)[0][0]


templates = [
    route for route in data["routes"]
    if 1 <= sum(role == 5 for _, role in route["holds"]) <= 2
    and 3 <= sum(role == 6 for _, role in route["holds"]) <= 5
    and sum(role == 7 for _, role in route["holds"]) == 1
]
rng.shuffle(templates)
generated = []
seen = set(known)
attempts = 0
while len(generated) < 120 and attempts < 25000:
    template = templates[attempts % len(templates)]
    attempts += 1
    holds = [[int(hold_id), int(role)] for hold_id, role in template["holds"]]
    replaceable = [i for i, (_, role) in enumerate(holds) if role in (6, 8)]
    if not replaceable:
        continue
    target_count = 2 if len(replaceable) > 2 and rng.random() < .18 else 1
    changed = 0
    used = {hold_id for hold_id, _ in holds}
    used_indexes = set()
    for _ in range(target_count):
        choices = [i for i in replaceable if i not in used_indexes]
        if not choices:
            break
        index = rng.choice(choices)
        role = holds[index][1]
        new_id = replacement(role, holds[index][0], used)
        if new_id is None:
            continue
        used.remove(holds[index][0])
        used.add(new_id)
        used_indexes.add(index)
        holds[index][0] = new_id
        changed += 1
    key = signature(holds)
    if not changed or key in seen:
        continue
    movement_plan = plan(holds)
    if not movement_plan:
        continue
    seen.add(key)
    generated.append({
        "holds": holds,
        "plan": movement_plan,
        "source": {"grade": template["grade"]},
        "changed": changed,
    })

if len(generated) < 50:
    raise SystemExit(f"Only found {len(generated)} reach-checked novel routes after {attempts} attempts")

data["generated"] = generated
data_path.write_text(prefix + json.dumps(data, separators=(",", ":")) + ";\n")
print(f"Prepared {len(generated)} novel, reach-checked problems from {len(data['routes'])} real TB2 climbs after {attempts} candidates")
