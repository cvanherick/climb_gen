"""Normalize permitted climbing motion annotations to a wall-relative JSONL format.

Input is a JSON object with ``schema_version: 1`` and a ``sequences`` list. This
intentionally does not fetch videos, infer hold IDs, or guess dataset licenses.
See ``docs/motion-data-schema.md`` for the input contract.
"""

import argparse
import json
import math
from pathlib import Path


LIMBS = ("left_hand", "right_hand", "left_foot", "right_foot")


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def norm(v):
    return math.sqrt(dot(v, v))


def unit(v, name):
    length = norm(v)
    if length < 1e-8:
        raise ValueError(f"{name} must be non-zero")
    return [x / length for x in v]


def vec3(value, name):
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(f"{name} must be a three-number array")
    result = [float(x) for x in value]
    if not all(math.isfinite(x) for x in result):
        raise ValueError(f"{name} must contain finite numbers")
    return result


def wall_basis(sequence):
    frame = sequence["wall_frame"]
    origin = vec3(frame["origin_world_m"], "origin_world_m")
    horizontal = unit(vec3(frame["horizontal_axis_world"], "horizontal_axis_world"), "horizontal axis")
    raw_vertical = vec3(frame["vertical_axis_world"], "vertical_axis_world")
    vertical = [raw_vertical[i] - dot(raw_vertical, horizontal) * horizontal[i] for i in range(3)]
    vertical = unit(vertical, "vertical axis orthogonal to horizontal axis")
    scale = float(frame["board_units_per_meter"])
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("board_units_per_meter must be a positive finite number")
    return origin, horizontal, vertical, scale


def project(point, basis):
    origin, horizontal, vertical, scale = basis
    delta = [point[i] - origin[i] for i in range(3)]
    return [dot(delta, horizontal) * scale, dot(delta, vertical) * scale]


def prepare_sequence(sequence):
    source = sequence.get("source", {})
    rights = source.get("rights", {})
    if rights.get("training_permitted") is not True:
        raise ValueError("source.rights.training_permitted must be explicitly true")
    if not source.get("dataset") or not source.get("license"):
        raise ValueError("source.dataset and source.license are required for provenance")
    if not sequence.get("sequence_id"):
        raise ValueError("sequence_id is required")
    scale = float(sequence["body_scale_m"])
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("body_scale_m must be a positive finite number")

    basis = wall_basis(sequence)
    output = []
    previous_t = -math.inf
    for frame_index, frame in enumerate(sequence.get("frames", [])):
        t = float(frame["t_sec"])
        if not math.isfinite(t) or t <= previous_t:
            raise ValueError(f"frame {frame_index}: t_sec values must increase")
        previous_t = t
        joints = frame.get("joints_world_m", {})
        if "pelvis" not in joints:
            raise ValueError(f"frame {frame_index}: joints_world_m.pelvis is required")
        pelvis = project(vec3(joints["pelvis"], "pelvis joint"), basis)
        joints_board = {name: project(vec3(point, f"joint {name}"), basis) for name, point in joints.items()}
        joints_relative = {
            name: [(xy[0] - pelvis[0]) / scale, (xy[1] - pelvis[1]) / scale]
            for name, xy in joints_board.items()
        }

        contacts = {}
        for limb in LIMBS:
            contact = frame.get("contacts", {}).get(limb)
            if contact is None:
                contacts[limb] = None
                continue
            normalized = {}
            # IDs are carried through verbatim. The adapter never snaps inferred
            # detections onto a board hold; that mapping requires trusted labels.
            if "hold_id" in contact:
                normalized["hold_id"] = contact["hold_id"]
            if "world_m" in contact:
                xy = project(vec3(contact["world_m"], f"{limb} contact"), basis)
                normalized["board_xy"] = xy
                normalized["pelvis_relative_body"] = [(xy[0] - pelvis[0]) / scale, (xy[1] - pelvis[1]) / scale]
            if not normalized:
                raise ValueError(f"frame {frame_index}: {limb} contact needs hold_id and/or world_m")
            contacts[limb] = normalized

        output.append({
            "sequence_id": sequence["sequence_id"],
            "source": source,
            "frame_index": frame_index,
            "t_sec": t,
            "joints_board": joints_board,
            "joints_pelvis_body": joints_relative,
            "contacts": contacts,
        })
    if not output:
        raise ValueError("sequence must contain at least one frame")
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Canonical JSON input (schema version 1)")
    parser.add_argument("output", type=Path, help="Output JSONL path")
    args = parser.parse_args()
    payload = json.loads(args.input.read_text())
    if payload.get("schema_version") != 1 or not isinstance(payload.get("sequences"), list):
        raise SystemExit("Expected schema_version: 1 and a sequences array")
    records = []
    for sequence in payload["sequences"]:
        try:
            records.extend(prepare_sequence(sequence))
        except (KeyError, TypeError, ValueError) as exc:
            raise SystemExit(f"Sequence {sequence.get('sequence_id', '<unknown>')}: {exc}") from exc
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w") as stream:
        for record in records:
            stream.write(json.dumps(record, separators=(",", ":")) + "\n")
    print(f"Wrote {len(records)} normalized frames to {args.output}")


if __name__ == "__main__":
    main()
