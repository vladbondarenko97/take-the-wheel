# take-the-wheel

- Test (same as CI): `for f in setup.mjs runner/*.mjs runner/lab/*.mjs runner/bin/* test/*.mjs extension/*.js; do node --check "$f"; done && bash -n scripts/mac-cd.sh && npm test`
- Restart the runner on this Mac: `launchctl kickstart -k gui/$(id -u)/com.takethewheel.runner` (installed by `setup.mjs`, logs in `~/.take-the-wheel/runner.log`).
- Other Macs deploy themselves: `com.takethewheel.deploy` runs `scripts/mac-cd.sh` every minute and fast-forwards to `main` once the workflow named `CI` passes (idle runner, clean checkout only). Deploy = commit + push. Keep the workflow name `CI`. Panel changes still need a manual extension reload.
- Runner HTTP API on `localhost:19826`, bearer token in `runner/.token`. The side panel only talks to the runner on its own machine.
- opencli 2.x: every call is `opencli browser --session <s> <cmd>`; `eval` output is wrapped as `{"ok":true,"data":…}` (unwrap with `evalJs` in ttw/labctl).
- Local vision and the local agent model = oMLX, at `http://localhost:8000/v1`, model `gemma-4-12B-it-oQ4e-mtp`. Env: `LABCTL_VISION_URL`, `LABCTL_VISION_MODEL`, `LABCTL_VISION_KEY` (falls back to `~/.omlx/settings.json` auth.api_key). Per-machine overrides go in `~/.take-the-wheel/env`.
- The vision defaults are duplicated in `runner/runner.mjs` and `runner/lab/labctl.mjs`; keep them in sync.
- Local model ("Gemma 12B (local)"): keep `MAX_THINKING_TOKENS=0` (thinking breaks oMLX's prefix cache, so every turn re-reads the whole conversation). It may only act through `ttw do`/`ttw fill` (guard `ttwActs`).
- Testing `ttw do` from a shell: run each call in its own shell (`bash -c '…; true'`), since ttw refuses a second advance from the same parent pid.
