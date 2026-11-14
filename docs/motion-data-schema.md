# Motion annotation import format

`scripts/prepare_motion_data.py` converts explicitly permitted motion annotations to wall-relative JSONL. It does not fetch or decode video, infer holds, or check licenses for you. Use it only when the dataset owner’s terms allow the intended model-training use.

The input is UTF-8 JSON with `schema_version: 1` and a `sequences` array. Each sequence has:

```json
{
  "sequence_id": "clip-001",
  "source": {
    "dataset": "dataset name",
    "license": "license identifier or owner-approved terms",
    "rights": {
      "training_permitted": true,
      "source_video_redistribution_permitted": false
    }
  },
  "body_scale_m": 0.5,
  "wall_frame": {
    "origin_world_m": [0, 0, 0],
    "horizontal_axis_world": [1, 0, 0],
    "vertical_axis_world": [0, 1, 0],
    "board_units_per_meter": 100
  },
  "frames": [
    {
      "t_sec": 0.0,
      "joints_world_m": {"pelvis": [0, 0, 1], "left_hand": [0.2, 0.8, 1.5]},
      "contacts": {
        "left_hand": {"hold_id": 123, "world_m": [0.2, 0.8, 1.5]},
        "right_hand": null,
        "left_foot": {"hold_id": 234},
        "right_foot": null
      }
    }
  ]
}
```

The wall axes are projected from world coordinates and orthogonalized; `board_units_per_meter` calibrates the result to the chosen board coordinate scale. Body-relative joint and contact coordinates are also emitted in units of `body_scale_m`. Exact supplied `hold_id` values pass through unchanged. Position-only contacts stay position-only: this tool never snaps them to TB2 placements. Frame timestamps must increase and each frame needs a pelvis joint. Run:

```sh
python3 scripts/prepare_motion_data.py input.json output.jsonl
```

Keep source media and annotations subject to their original terms. The emitted JSONL repeats dataset/license provenance on every frame so downstream training manifests can retain it.
