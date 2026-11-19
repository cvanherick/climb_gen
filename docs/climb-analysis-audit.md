# TB2 Climb Analysis audit

## Run-through

Use two public clips in Chrome to exercise video import, playback, tracking, calibration, 2D and 3D views, contact editing, coaching links, and export. Check cancellation, invalid media, and mobile width separately. The public clips are from Kilter Boards, so this run exercises the workflow. Synthetic TB2 fixtures cover the board geometry and contact logic.

## Improvements

- [x] Synchronize frame readouts and overlays through tracking gaps. Show when frame stepping is seeking or using sampled timestamps.
- [x] Let reviewers preview, adjust, apply, or reset calibration without repicking every corner.
- [x] Keep manual contact edits on a tracking rerun, add undo, and make height and weight changes apply to cached results and the export.
- [x] Show contact durations by limb and distinguish automatic contacts from manual corrections in the timeline. Keep alternative beta planning responsive.
- [x] Recheck the revised flow in Chrome and run the complete automated suite.


## Findings and verification

- Before the changes, updating the height field left the 3D fit and JSON at the old height. After the changes, the 190 cm profile was exported while the cached pose frames stayed identical.
- Chrome confirmed calibration preview, adjusting and cancelling a corner change, clearing alignment, contact timeline selection, undo, cancellation, and correction persistence after a fresh inference run. The checks also covered coaching seeks, playback at 0.25×, adjacent frame stepping, the 2D and 3D views, mobile width, and invalid media handling.
- All 33 automated tests passed. New tests cover low-confidence or missing motion samples and the frame-step fallback.
- The worker tracked a pose in 88% and 99.6% of samples in the two public test clips. These figures describe pose coverage. They do not measure correct TB2 contacts, depth, forces, or coaching precision.

The remaining validation task is to benchmark contact and coaching accuracy against manually annotated footage of a 12 × 12 TB2 Mirror at 40°. The [README validation guide](../README.md#validation) documents the evaluator and label format.
