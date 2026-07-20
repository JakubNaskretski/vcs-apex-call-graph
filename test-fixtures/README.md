# Test fixtures

These source-controlled, fictional workspaces make the release verification
suite reproducible without machine-local example-data directories.

- `adv-org/` is the long-lived semantic and metadata regression corpus.
- `gauntlet-org/` is the adversarial corpus used by the release gauntlet.
- `ground-truth-org/` is the small independently specified graph fixture.
- `v071-extension/` contains only the published resolver/UI modules needed by
  the backwards-compatibility comparison.

All fixture directories are excluded from the shipped VSIX by `.vscodeignore`.
