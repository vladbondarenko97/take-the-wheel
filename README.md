# Take the Wheel

A Comet-style "take over my browser" side panel for Chrome. You type a task, Claude plans it, and [OpenCLI](https://github.com/jackwener/opencli) drives your real, logged-in tab with trusted CDP clicks and keystrokes.

```
side panel ext ──POST /task (SSE)──► runner.mjs :19826 ──spawn──► claude -p (Bash(opencli *) only)
                                                                      │
OpenCLI ext ◄──ws── OpenCLI daemon :19825 ◄──── opencli browser task … ┘
```

## Setup (once)

1. `npm i -g @jackwener/opencli`
2. Install the **OpenCLI** extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk). `opencli doctor` should then show no `[MISSING]`/`[FAIL]` lines.
3. `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`.
4. `node runner/runner.mjs`. It prints a token; paste that into the side panel's token field. The dot turns green when the runner, OpenCLI and Claude are all OK.

You must be logged in to Claude Code (`claude` works in a terminal). Runs count against your plan, with a per-run budget cap.

## Use

Open the tab you want driven, click the Take the Wheel toolbar icon, type the task, and press **Go** (or ⌘↩). Keep the panel open while a task runs: closing it stops the task. **Stop** interrupts `claude` and unbinds the tab. Chrome's "started debugging this browser" bar is the "Claude is driving" indicator.

Haiku is the default. Switch to Sonnet or Opus when the answers need real reasoning, such as spotting fake listings. It uses your Claude Code login (`authMethod: claude.ai`), not an API key; the `$` figures are Claude Code's API-price estimates and count against your plan's limits.

**Conversations.** ＋ starts a new conversation, the dropdown switches between them, and 🗑 deletes one. Each conversation keeps its Claude session: typing in an existing one sends a follow-up (the button says **Continue**) that resumes with full memory instead of re-exploring. Use ＋ for unrelated tasks, because every follow-up re-reads the whole conversation history. Claude reports cost cumulatively per session, so the panel shows each run's share and the conversation total.

**Handoffs.** Say "pause", "wait", or "stop at…" and the agent stops there. It also stops on logins, CAPTCHAs, or questions only you can answer. It ends with an amber **Waiting for you:** card. Do your part, then reply in the same conversation (e.g. "done, continue"). It never types passwords, 2FA codes, or payment details.

## Measured (2026-09-30, OUP companion-site practice quiz, 25 multiple-choice questions, not submitted)

| Prompt version | Model | Turns | Est. cost | Answered |
|---|---|---|---|---|
| v1 (state refs + scrolling) | Haiku | 29 | $0.33 | 23/25, but claimed 25 |
| v2 (choices listing + one chained `check`) | Haiku | 5 | $0.056 | 25/25, verified |

Other tasks (2026-09-30, per-run cost estimates):

| Task | Model | Turns | Est. cost | Result |
|---|---|---|---|---|
| "go on ebay.com and find the cheapest buy it now 1oz gold eagle listing" | Sonnet | 13 | $0.24 | $4,502.17 listing + runner-up with links; rejected mislabeled fractional coins |
| "go to yahoo.com login page and pause" | Haiku | 3 | $0.015 | Stopped on login.yahoo.com with a "Waiting for you" line |
| Follow-up in the eBay conversation: returns policy / capsule? | Haiku | 7 | ~$0.10 | Knew which listing "the winner" was; no returns; packaging is only in the seller's cross-origin description iframe |

`state` snapshots are size-capped (~30 KB here) and cut off long pages. v2's read-only `eval` listing returns every question with name/value selectors in 8.5 KB, and the same call doubles as verification.

While a task runs, the driven tab gets a rainbow aura, a "Claude is driving" pill, and an animated card on the left for each click, check or text entry (`extension/fx.js`). These are page-only effects in a closed shadow root with pointer events off. They cost no Claude usage and don't show up in OpenCLI snapshots.

## Adapting to any quiz or form (`runner/bin/ttw`)

The agent works any site through a few generic helpers instead of site-specific code:

- `ttw page`: digest of any page. It finds the question text, choices (native radios/checkboxes, ARIA widgets, answer buttons, clickable cards), inputs, images, **advance** buttons (Next/Continue/Start) and **finish** buttons (Submit/See Results), plus progress ("3 of 10", progress bars, or quiz data on the page). Logic lives in `runner/digest.js`.
- `ttw do c2 a1` answers, advances, waits for the next question and prints its digest in one call. `ttw do c2 next` handles pages that reveal Next only after answering. It refuses finish buttons and refuses advancing on the last question unless given `--finish`.
- `ttw look`: screenshot the agent views with Read (Read is limited to `~/.take-the-wheel/shots/`). Used only when a question depends on an image, once per distinct image.
- The page's `alert`/`confirm`/`prompt` are captured before every action, so they can't freeze the tab. Confirms are cancelled, never accepted.
- `ttw note`: per-site notes in `~/.take-the-wheel/sites/<host>.md`, shown to the agent on later runs.

| Quiz (2026-09-30) | Format | Model | Turns | Est. cost | Result |
|---|---|---|---|---|---|
| free-anatomy-quiz.com planes & directions | 1 question/page, labeled diagrams, feedback screens, total only in page data | Sonnet | 27 | $0.20 | 15/15 answered, stopped on Q15; site tally 13/14 correct before Q15; 3 image looks |
| britannica.com This or That WWI vs WWII | start screen, answer buttons reveal Next, countdown toggle | Sonnet | 14 | $0.08 | 10/10, timer turned off, stopped before "See Results" |
| OUP companion quiz (regression) | 25 questions on one page | Haiku | 4 | $0.034 | 25/25 in one `ttw do` call |

## Local test pages

```
python3 -m http.server 8000   # from the repo root
```
- http://localhost:8000/test/fx-demo.html shows the effects without the extension or Claude.
- http://localhost:8000/test/quiz.html: give the task: *"Answer every question on this quiz, fill name Ada Lovelace, country Romania, tick the confirmation and submit."* A good run is ≤ 6 turns and ≤ $0.10 on Haiku.

## How cost stays low

- The replacement system prompt (`runner/agent-prompt.md`) has a short OpenCLI cheat sheet, not Claude Code's default prompt.
- The only tool is Bash, limited to `opencli *`. `&&`-chained opencli commands are allowed; anything else is denied (verified).
- Read-all → think-once → act-all: one snapshot, then every answer applied in one chained call.
- Text reads only. The agent can't see images, so `screenshot` is blocked by a `--disallowedTools` rule (verified, including inside `&&` chains).
- Search tasks go straight to filtered search URLs, and detail pages get targeted reads instead of full snapshots.
- `--effort low`, `--max-turns 30`, `--max-budget-usd` (default $0.50).

## Guardrails

- The runner listens on `127.0.0.1` only. It requires the bearer token in `runner/.token` and rejects requests carrying a non-extension `Origin`.
- `runner/denylist.json` blocks tasks started on banking, email, payment and exchange sites. This checks only the starting tab. The prompt also tells the agent to stop if it lands on one.
- The agent stops and hands back control on logins, CAPTCHAs, payments or other irreversible steps you didn't ask for, and graded or proctored exams.
- One task at a time.

Keep it off graded coursework and exams: they usually prohibit AI help.

## Not done yet (M5+)

Esc-to-stop from the page, trusted wheel scrolling (OpenCLI scroll uses `window.scrollBy`), per-key typing mode, cosmetic cursor, and recipe capture for repeat sites.
