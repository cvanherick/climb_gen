# Climb analysis improvements

## Prioritized list

- [x] **Resume a review.** Restore the profile, alignment, corrections, and playhead alongside the original local video.
- [x] **Analyze a segment.** Let people skip setup footage and track just the climb while keeping original video timestamps.
- [x] **Find uncertain contacts.** Jump between low-confidence automatic contacts to review them against the footage.
- [ ] **Measure TB2 accuracy.** Compare predictions with manually annotated 40° TB2 Mirror footage when the clips and labels are available.

## Implementation plan

- Validate saved exports against the selected clip and known hold IDs. Restore the saved pose samples and corrections, then recompute derived results with the current analysis code. Accept previous exports.
- Add range controls and have the tracker process that range. Keep playback available for the whole clip and distinguish untracked portions from tracking gaps.
- Add navigation through uncertain contact intervals using the existing correction form and timeline.
- Check the data validation and range boundaries with automated tests. Exercise segment tracking, export, reopening, and contact review in Chrome.

## Verification

All 36 automated tests passed. In Chrome at mobile width, the local tracker analyzed an eight-second segment of a public climbing clip. The browser test checked that all 97 samples were within the selected range, used the uncertain-contact shortcut, saved a manual correction, rejected the review on a different video, and reopened it on the original video with pose-model requests blocked. The fixture was recorded on a Kilter Board and does not establish TB2 contact accuracy.
