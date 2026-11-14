"""Train a grade-conditional DDPM over TB2 Mirror hold-role grids.

The model is trained on real 40-degree routes. It samples candidate climbs
offline; candidates are projected to legal hold counts, reach-checked, and
bundled for the static Pages app to serve instantly.
"""

import argparse
import hashlib
import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data/tb2-mirror-40.js"
MODEL_PATH = ROOT / "models/tb2-grade-diffusion.pt"
PREFIX = "window.CLIMBGEN_DATA = "
GRADES = [f"V{i}" for i in range(12)]
ROLE_ORDER = (5, 6, 7, 8)  # start, hand, finish, foot
ROLE_TO_CHANNEL = {role: i for i, role in enumerate(ROLE_ORDER)}
NUM_STEPS = 24
UNCONDITIONAL_GRADE = len(GRADES)


class ResidualBlock(nn.Module):
    def __init__(self, width):
        super().__init__()
        self.norm = nn.LayerNorm(width)
        self.first = nn.Linear(width, width)
        self.second = nn.Linear(width, width)
        self.dropout = nn.Dropout(0.08)

    def forward(self, x):
        y = self.norm(x)
        y = self.first(y)
        y = F.silu(y)
        y = self.dropout(y)
        y = self.second(y)
        return x + y * 0.5


class GradeConditionalDenoiser(nn.Module):
    def __init__(self, hold_count, width=320):
        super().__init__()
        self.hold_count = hold_count
        self.grade_embedding = nn.Embedding(len(GRADES) + 1, 24)
        self.input = nn.Linear(hold_count * len(ROLE_ORDER) + 56, width)
        self.blocks = nn.ModuleList([ResidualBlock(width) for _ in range(3)])
        self.output_norm = nn.LayerNorm(width)
        self.output = nn.Linear(width, hold_count * len(ROLE_ORDER))

    @staticmethod
    def time_embedding(t):
        half = 16
        steps = t.float().reshape(-1, 1) / NUM_STEPS
        freq = torch.exp(torch.arange(half, device=t.device, dtype=torch.float32) * (-math.log(10000) / max(half - 1, 1)))
        angles = steps * freq.reshape(1, -1) * (2 * math.pi)
        return torch.cat([torch.sin(angles), torch.cos(angles)], dim=1)

    def forward(self, x, timestep, grade):
        conditioned = torch.cat([
            x,
            self.time_embedding(timestep),
            self.grade_embedding(grade),
        ], dim=1)
        h = F.silu(self.input(conditioned))
        for block in self.blocks:
            h = block(h)
        return self.output(self.output_norm(h))


def load_data():
    raw = DATA_PATH.read_text().strip()
    if not raw.startswith(PREFIX) or not raw.endswith(";"):
        raise SystemExit("Unexpected TB2 data wrapper")
    data = json.loads(raw[len(PREFIX):-1])
    return data


def signature(holds):
    return "|".join(sorted(f"{int(hold_id)}r{int(role)}" for hold_id, role in holds))


def movement_plan(holds, positions):
    starts = sorted((int(i) for i, role in holds if role == 5), key=lambda i: positions[i]["x"])
    middle = [int(i) for i, role in holds if role == 6]
    finishes = [int(i) for i, role in holds if role == 7]
    if not starts or not middle or not finishes:
        return None

    left_start, right_start = starts[0], starts[-1]
    reach = 43.0
    memo = {}

    def distance(a, b):
        aa, bb = positions[a], positions[b]
        return math.hypot(aa["x"] - bb["x"], aa["y"] - bb["y"])

    def visit(left, right, remaining, previous_side):
        key = (left, right, tuple(sorted(remaining)), previous_side)
        if key in memo:
            return memo[key]
        if not remaining:
            options = []
            for finish in finishes:
                for side, limb, origin in (("left", "L hand", left), ("right", "R hand", right)):
                    d = distance(origin, finish)
                    if d <= reach:
                        options.append((d + (5 if side == previous_side else 0), finish, limb))
            if not options:
                memo[key] = None
                return None
            _, finish, limb = min(options)
            result = [{"id": finish, "limb": limb, "role": 7}]
            memo[key] = result
            return result

        options = []
        for hold_id in remaining:
            for side, limb, origin in (("left", "L hand", left), ("right", "R hand", right)):
                d = distance(origin, hold_id)
                if d <= reach:
                    options.append((d + (5 if side == previous_side else 0), hold_id, side, limb))
        options.sort()
        for _, hold_id, side, limb in options:
            rest = tuple(i for i in remaining if i != hold_id)
            next_left = hold_id if side == "left" else left
            next_right = hold_id if side == "right" else right
            suffix = visit(next_left, next_right, rest, side)
            if suffix is not None:
                result = [{"id": hold_id, "limb": limb, "role": 6}, *suffix]
                memo[key] = result
                return result
        memo[key] = None
        return None

    return visit(left_start, right_start, tuple(middle), None)


def route_passes_app_quality(holds, positions):
    """Keep diffusion samples inside the same structural limits as the app."""
    starts = [positions[int(i)] for i, role in holds if int(role) == 5]
    hands = [positions[int(i)] for i, role in holds if int(role) == 6]
    finishes = [positions[int(i)] for i, role in holds if int(role) == 7]
    feet = [positions[int(i)] for i, role in holds if int(role) == 8]
    if not 1 <= len(starts) <= 2 or not 3 <= len(hands) <= 5 or len(finishes) != 1 or not feet:
        return False
    start_y = sum(p["y"] for p in starts) / len(starts)
    finish_y = finishes[0]["y"]
    all_hands = starts + hands + finishes
    if any(p["y"] > 44 for p in starts):
        return False
    if len(starts) > 1 and math.dist((starts[0]["x"], starts[0]["y"]), (starts[1]["x"], starts[1]["y"])) > 40:
        return False
    if finish_y - start_y < 24:
        return False
    if max(p["y"] for p in all_hands) - min(p["y"] for p in all_hands) < 48:
        return False
    if sum(p["y"] < start_y - 10 for p in hands) > 1:
        return False
    if any(min(math.dist((p["x"], p["y"]), (q["x"], q["y"])) for q in all_hands if q is not p) > 36 for p in hands):
        return False

    finish = finishes[0]
    initial_y = start_y
    memo = set()

    def reaches(left, right, remaining, last_y):
        if not remaining:
            return min(math.dist((left["x"], left["y"]), (finish["x"], finish["y"])),
                       math.dist((right["x"], right["y"]), (finish["x"], finish["y"]))) <= 36 and finish["y"] >= initial_y + 20 and finish["y"] >= last_y - 20
        key = (left["id"], right["id"], tuple(sorted(p["id"] for p in remaining)), round(last_y / 8))
        if key in memo:
            return False
        memo.add(key)
        for target in remaining:
            if target["y"] < last_y - 20:
                continue
            rest = [p for p in remaining if p is not target]
            if math.dist((left["x"], left["y"]), (target["x"], target["y"])) <= 36 and reaches(target, right, rest, target["y"]):
                return True
            if math.dist((right["x"], right["y"]), (target["x"], target["y"])) <= 36 and reaches(left, target, rest, target["y"]):
                return True
        return False

    left, right = sorted(starts, key=lambda p: p["x"])[0], sorted(starts, key=lambda p: p["x"])[-1]
    return reaches(left, right, hands, initial_y)


def route_tensor(route, hold_index):
    value = np.zeros((len(hold_index), len(ROLE_ORDER)), dtype=np.float32)
    for hold_id, role in route["holds"]:
        if int(hold_id) not in hold_index or int(role) not in ROLE_TO_CHANNEL:
            continue
        value[hold_index[int(hold_id)], ROLE_TO_CHANNEL[int(role)]] = 1.0
    return value.reshape(-1)


def route_holds_from_scores(scores, counts, placements, rng):
    # Slight Gumbel noise keeps repeated samples diverse while the model scores
    # continue to determine likely placements.
    scores = np.asarray(scores, dtype=np.float32).reshape(len(placements), len(ROLE_ORDER))
    uniform = np.clip(np.asarray(rng.random(scores.shape)), 1e-6, 1 - 1e-6)
    gumbel = -np.log(-np.log(uniform))
    scores = scores + 0.12 * gumbel
    used = set()
    holds = []
    # Place endpoints first, then hands and feet, preventing role collisions.
    for role in (7, 5, 6, 8):
        channel = ROLE_TO_CHANNEL[role]
        amount = counts[role]
        ranking = np.argsort(scores[:, channel])[::-1]
        selected = [int(i) for i in ranking if int(i) not in used][:amount]
        if len(selected) < amount:
            return None
        used.update(selected)
        holds.extend([[int(placements[i]["id"]), role] for i in selected])
    return holds


def project_scores_onto_route(scores, reference, placements, rng, grade_frequency):
    """Project model scores onto a grade-matched, climb-shaped route.

    Independent per-hold argmaxes often create disconnected sets. Starting
    from a real route of the requested grade preserves its hold-count and
    movement shape while diffusion scores choose the new contacts.
    """
    scores = np.asarray(scores, dtype=np.float32).reshape(len(placements), len(ROLE_ORDER))
    hold_index = {int(hold["id"]): index for index, hold in enumerate(placements)}
    holds = [[int(i), int(role)] for i, role in reference["holds"]]
    mutable = [index for index, (_, role) in enumerate(holds) if role in (6, 8)]
    if not mutable:
        return None
    edit_count = min(len(mutable), 1 + int(rng.integers(0, 3)))
    edit_order = list(rng.permutation(mutable)[:edit_count])
    used = {str(hold_id) for hold_id, _ in holds}
    changed = 0
    for route_index in edit_order:
        old_id, role = holds[route_index]
        old = placements[hold_index[old_id]]
        channel = ROLE_TO_CHANNEL[role]
        candidates = []
        for placement_index, candidate in enumerate(placements):
            candidate_id = str(candidate["id"])
            if candidate_id in used:
                continue
            distance = math.hypot(candidate["x"] - old["x"], candidate["y"] - old["y"])
            if not 4 <= distance <= 24:
                continue
            # Dataset frequency is a light prior; the requested-grade
            # diffusion score remains the main signal for a replacement.
            count = grade_frequency.get(role, {}).get(candidate_id, 0)
            score = float(scores[placement_index, channel]) + 0.12 * math.log1p(count)
            candidates.append((score, candidate_id, int(candidate["id"])))
        if not candidates:
            continue
        candidates.sort(reverse=True)
        shortlist = candidates[:32]
        logits = np.asarray([row[0] for row in shortlist], dtype=np.float64)
        logits = np.exp(np.clip((logits - logits.max()) / 0.35, -30, 0))
        choice = int(rng.choice(len(shortlist), p=logits / logits.sum()))
        replacement_id = shortlist[choice][2]
        used.remove(str(old_id))
        used.add(str(replacement_id))
        holds[route_index] = [replacement_id, role]
        changed += 1
    return (holds, changed) if changed else None


def train_model(data, epochs, seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.set_num_threads(min(4, torch.get_num_threads()))
    device = torch.device("cpu")

    placements = data["placements"]
    hold_index = {int(hold["id"]): i for i, hold in enumerate(placements)}
    routes_by_grade = defaultdict(list)
    for route in data["routes"]:
        grade = route.get("grade")
        if grade in GRADES:
            routes_by_grade[grade].append(route)
    routes = [route for grade in GRADES for route in routes_by_grade[grade]]
    if not routes:
        raise SystemExit("No labeled TB2 routes available for grades V0–V11")

    x = np.stack([route_tensor(route, hold_index) for route in routes])
    grades = np.asarray([GRADES.index(route["grade"]) for route in routes], dtype=np.int64)
    # Split each grade separately. A single global random split can leave rare
    # grades (especially V0/V1/V11) with almost no validation examples.
    training_parts, validation_parts = [], []
    for grade_index in range(len(GRADES)):
        grade_indices = np.flatnonzero(grades == grade_index)
        np.random.shuffle(grade_indices)
        validation_size = max(1, round(len(grade_indices) * 0.1))
        validation_parts.extend(grade_indices[:validation_size].tolist())
        training_parts.extend(grade_indices[validation_size:].tolist())
    training_idx = np.asarray(training_parts, dtype=np.int64)
    validation_idx = np.asarray(validation_parts, dtype=np.int64)
    x_train = torch.tensor(x[training_idx], device=device)
    g_train = torch.tensor(grades[training_idx], device=device)
    x_valid = torch.tensor(x[validation_idx], device=device)
    g_valid = torch.tensor(grades[validation_idx], device=device)

    model = GradeConditionalDenoiser(len(placements)).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2.0e-4, weight_decay=1.0e-4)
    betas = torch.linspace(1.0e-4, 0.02, NUM_STEPS, device=device)
    alphas = 1.0 - betas
    alpha_bar = torch.cumprod(alphas, dim=0)
    best_validation = float("inf")
    best_state = None
    batch_size = 96

    def evaluate():
        model.eval()
        losses_by_grade = defaultdict(list)
        with torch.no_grad():
            for start in range(0, len(x_valid), batch_size):
                clean = x_valid[start:start + batch_size]
                grade = g_valid[start:start + batch_size]
                t = torch.randint(1, NUM_STEPS + 1, (len(clean),), device=device)
                noise = torch.randn_like(clean)
                a = alpha_bar[t - 1].unsqueeze(1)
                noisy = a.sqrt() * clean + (1 - a).sqrt() * noise
                prediction = model(noisy, t, grade)
                per_example_loss = (prediction - noise).square().mean(dim=1)
                for grade_index in range(len(GRADES)):
                    mask = grade == grade_index
                    if mask.any():
                        losses_by_grade[grade_index].extend(per_example_loss[mask].cpu().tolist())
        per_grade = {
            GRADES[index]: float(np.mean(values))
            for index, values in losses_by_grade.items()
        }
        # Macro-average prevents the most common grades from deciding which
        # checkpoint is kept.
        return float(np.mean(list(per_grade.values()))), per_grade

    train_grade_counts = np.bincount(grades[training_idx], minlength=len(GRADES))
    grade_sample_weights = 1.0 / np.sqrt(train_grade_counts[grades[training_idx]].astype(np.float64))
    grade_sample_weights /= grade_sample_weights.sum()

    for epoch in range(1, epochs + 1):
        model.train()
        # Mild inverse-square-root reweighting gives underrepresented grades
        # more gradient updates without repeatedly cloning the rarest routes
        # as aggressively as strict class balancing would.
        order = torch.multinomial(
            torch.as_tensor(grade_sample_weights, dtype=torch.double),
            len(x_train), replacement=True,
        )
        total_loss = 0.0
        batches = 0
        for start in range(0, len(order), batch_size):
            idx = order[start:start + batch_size]
            clean, grade = x_train[idx], g_train[idx]
            t = torch.randint(1, NUM_STEPS + 1, (len(clean),), device=device)
            noise = torch.randn_like(clean)
            a = alpha_bar[t - 1].unsqueeze(1)
            noisy = a.sqrt() * clean + (1 - a).sqrt() * noise
            # Classifier-free grade dropout lets the trained denoiser support
            # stronger or weaker grade guidance during sampling.
            condition = grade.clone()
            condition[torch.rand(len(grade), device=device) < 0.12] = UNCONDITIONAL_GRADE
            prediction = model(noisy, t, condition)
            loss = F.mse_loss(prediction, noise)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            total_loss += float(loss)
            batches += 1

        validation_loss, validation_by_grade = evaluate()
        if validation_loss < best_validation:
            best_validation = validation_loss
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
        if epoch == 1 or epoch % 10 == 0 or epoch == epochs:
            print(f"epoch {epoch:03d}/{epochs} train_noise_loss={total_loss / max(batches, 1):.4f} val_grade_macro_loss={validation_loss:.4f}")

    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    return model, routes_by_grade, hold_index, betas, alphas, alpha_bar, best_validation, train_grade_counts


@torch.no_grad()
def sample_diffusion(model, grades, betas, alphas, alpha_bar, hold_count, guidance=2.2):
    device = next(model.parameters()).device
    grades_tensor = torch.tensor([GRADES.index(g) for g in grades], dtype=torch.long, device=device)
    state = torch.randn(len(grades), hold_count * len(ROLE_ORDER), device=device)
    for step in range(NUM_STEPS, 0, -1):
        t = torch.full((len(grades),), step, dtype=torch.long, device=device)
        uncond = torch.full_like(grades_tensor, UNCONDITIONAL_GRADE)
        both_state = torch.cat([state, state], dim=0)
        both_t = torch.cat([t, t], dim=0)
        both_grade = torch.cat([uncond, grades_tensor], dim=0)
        eps_uncond, eps_grade = model(both_state, both_t, both_grade).chunk(2, dim=0)
        eps = eps_uncond + guidance * (eps_grade - eps_uncond)
        beta = betas[step - 1]
        alpha = alphas[step - 1]
        ab = alpha_bar[step - 1]
        state = (state - beta / torch.sqrt(1 - ab) * eps) / torch.sqrt(alpha)
        if step > 1:
            state = state + torch.sqrt(beta) * torch.randn_like(state)
    return state.cpu().numpy().reshape(len(grades), hold_count, len(ROLE_ORDER))


def main():
    parser = argparse.ArgumentParser(description="Train the TB2 grade-conditional diffusion model and regenerate the app pool")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--samples-per-grade", type=int, default=300)
    parser.add_argument("--seed", type=int, default=180)
    parser.add_argument("--model-path", type=Path, default=MODEL_PATH)
    args = parser.parse_args()

    data = load_data()
    model, routes_by_grade, hold_index, betas, alphas, alpha_bar, validation_loss, train_grade_counts = train_model(data, args.epochs, args.seed)
    args.model_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "state_dict": model.state_dict(),
        "hold_ids": [int(hold["id"]) for hold in data["placements"]],
        "grades": GRADES,
        "timesteps": NUM_STEPS,
        "hold_count": len(data["placements"]),
        "validation_noise_loss": validation_loss,
        "training_routes": sum(len(routes_by_grade[grade]) for grade in GRADES),
        "training_routes_by_grade": {grade: int(train_grade_counts[index]) for index, grade in enumerate(GRADES)},
        "grade_conditioning": "learned grade embedding with classifier-free dropout; inverse-sqrt grade sampling",
        "seed": args.seed,
    }, args.model_path)

    rng = np.random.default_rng(args.seed + 1)
    sample_grades = [grade for grade in GRADES for _ in range(args.samples_per_grade)]
    sampled_scores = sample_diffusion(model, sample_grades, betas, alphas, alpha_bar, len(data["placements"]))
    positions = {int(hold["id"]): hold for hold in data["placements"]}
    reference_routes = {
        grade: [route for route in routes_by_grade[grade]
                if route_passes_app_quality(route["holds"], positions)
                and movement_plan(route["holds"], positions)]
        for grade in GRADES
    }
    grade_frequency = defaultdict(lambda: defaultdict(Counter))
    for grade in GRADES:
        for route in reference_routes[grade]:
            for hold_id, role in route["holds"]:
                grade_frequency[grade][int(role)][str(int(hold_id))] += 1
    placement_by_id = {int(hold["id"]): hold for hold in data["placements"]}
    original_signatures = {signature(route["holds"]) for route in data["routes"]}
    generated_signatures = set()
    model_by_grade = defaultdict(list)
    for score, grade in zip(sampled_scores, sample_grades):
        grade_routes = reference_routes[grade]
        if not grade_routes:
            continue
        reference = random.choice(grade_routes)
        projected = project_scores_onto_route(score, reference, data["placements"], rng, grade_frequency[grade])
        if not projected:
            continue
        holds, changed = projected
        if not route_passes_app_quality(holds, positions):
            continue
        key = signature(holds)
        if key in original_signatures or key in generated_signatures:
            continue
        plan = movement_plan(holds, positions)
        if not plan:
            continue
        generated_signatures.add(key)
        model_by_grade[grade].append({
            "holds": holds,
            "plan": plan,
            "source": {"grade": grade},
            "changed": changed,
            "generator": "grade-conditional-ddpm",
        })

    # Keep only candidates from this checkpoint. Reusing the previous pool
    # would mix old model samples with the newly balanced grade conditioning.
    # Fill sparse buckets with clearly identified real examples, not stale
    # diffusion output.
    conditioned_pool = []
    counts_by_grade = {}
    for grade in GRADES:
        bucket = model_by_grade[grade][:8]
        signatures = {signature(candidate["holds"]) for candidate in bucket}
        if len(bucket) < 10:
            for route in routes_by_grade[grade]:
                if len(bucket) >= 10:
                    break
                key = signature(route["holds"])
                if key in signatures:
                    continue
                plan = movement_plan(route["holds"], positions)
                if not plan:
                    continue
                signatures.add(key)
                bucket.append({
                    "holds": route["holds"],
                    "plan": plan,
                    "source": {"grade": grade},
                    "changed": 0,
                })
        conditioned_pool.extend(bucket)
        counts_by_grade[grade] = {"diffusion": sum(c.get("generator") == "grade-conditional-ddpm" for c in bucket), "total": len(bucket)}

    if not any(candidate.get("generator") == "grade-conditional-ddpm" for candidate in conditioned_pool):
        raise SystemExit("The trained sampler produced no novel, reachable routes; refusing to label heuristic routes as diffusion output")

    data["generated"] = conditioned_pool
    data["generator"] = {
        "type": "grade-conditional DDPM",
        "training_routes": sum(len(routes_by_grade[grade]) for grade in GRADES),
        "validation_noise_loss": round(validation_loss, 6),
        "timesteps": NUM_STEPS,
        "grades": GRADES,
        "diffusion_routes_by_grade": counts_by_grade,
        "model_sha256": hashlib.sha256(args.model_path.read_bytes()).hexdigest(),
        "grade_conditioning": "learned grade embedding; macro validation; inverse-sqrt grade sampling; CFG scale 2.2",
        "training_routes_by_grade": {grade: int(train_grade_counts[index]) for index, grade in enumerate(GRADES)},
    }
    DATA_PATH.write_text(PREFIX + json.dumps(data, separators=(",", ":")) + ";\n")
    print(f"Saved checkpoint: {args.model_path}")
    print(f"Validation noise loss: {validation_loss:.4f}")
    print(f"Grade-conditioned pool: {counts_by_grade}")


if __name__ == "__main__":
    main()
