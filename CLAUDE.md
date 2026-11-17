# take-the-wheel

- Test (same as CI): `for f in setup.mjs runner/*.mjs runner/lab/*.mjs runner/bin/* test/*.mjs extension/*.js; do node --check "$f"; done && npm test`
- Deploy locally = restart the runner: `launchctl kickstart -k gui/$(id -u)/com.takethewheel.runner` (installed by `setup.mjs`, logs in `~/.take-the-wheel/runner.log`).
- Runner HTTP API on `localhost:19826`, bearer token in `runner/.token`.
- Local vision (lab mode) = oMLX, OpenAI-compatible, at `http://localhost:8000/v1`, model `gemma-4-12B-it-oQ4e-mtp`. Env: `LABCTL_VISION_URL`, `LABCTL_VISION_MODEL`, `LABCTL_VISION_KEY` (falls back to `~/.omlx/settings.json` auth.api_key). Per-machine overrides go in `~/.take-the-wheel/env`.
- The vision defaults are duplicated in `runner/runner.mjs` and `runner/lab/labctl.mjs`; keep them in sync.
