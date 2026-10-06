# Aether Chess — Python Backend API Reference

The Python backend (`backend/service.py`) communicates over **stdin/stdout** using newline-delimited JSON.

All requests follow the shape:

```json
{ "id": "<string>", "command": "<name>", "params": { ... } }
```

All responses follow the shape:

```json
{ "id": "<string>", "result": { ... } }     // success
{ "id": "<string>", "error": "<message>" }  // failure
```

An unknown command produces an error, not a crash:

```json
{ "id": "r7", "error": "Unknown command: bogus_command" }
```

> Run it with `python backend/service.py`, **not** `python -m backend.service`.
> The module uses flat imports (`from analysis import ...`), which resolve
> because running the script puts `backend/` on `sys.path`.

> Backend tests run from the repo root as `venv/bin/python -m unittest
discover -s tests` — see [SETUP](SETUP.md#7-run-the-tests) for why the
> `venv/` prefix is required.

---

## The Bot Model

Every engine in the app is a **bot**: Stockfish, Mentor, and Maia3. They share
one interface and one result shape, so callers never branch on which one ran.

### Bot ids

A `bot_id` is an open string, not a closed enum. Ids come from the backend
(`list_bots`), never from a hard-coded list in the frontend.

| `bot_id`            | What it is                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `mentor`            | Built-in PVS engine in pure Python. Always available, no binary needed. Default bot.                        |
| `stockfish`         | Canonical Stockfish. Resolves a binary per move; honours a per-request path.                                |
| `stockfish-<major>` | One entry per _discovered_ build, e.g. `stockfish-19`, `stockfish-18`. Selecting one pins that exact build. |
| `maia3`             | Neural proxy that plays like a human of a chosen Elo. Sampled, not deterministic.                           |
| `auto`              | Not a real bot. Asks the manager to pick the best available one (Stockfish → Mentor → Maia3).               |

### The standard move result

Every bot returns this exact shape. A field is `null` when that bot cannot
supply it, and `move: null` means the bot failed to produce a move.

```json
{
  "move": "g1f3",
  "san": "Nf3",
  "from_book": false,
  "bot_id": "mentor",
  "eval_cp": 0,
  "depth": null,
  "elapsed_sec": 4.94,
  "ponder": null,
  "is_mate": false,
  "mate_in": null
}
```

| Field         | Type             | Meaning                                                                     |
| ------------- | ---------------- | --------------------------------------------------------------------------- |
| `move`        | `string \| null` | Move in UCI. `null` on failure.                                             |
| `san`         | `string \| null` | Same move in SAN.                                                           |
| `from_book`   | `bool`           | Came from the opening book rather than a search.                            |
| `bot_id`      | `string`         | Which bot actually produced this.                                           |
| `eval_cp`     | `int \| null`    | Centipawns from the side to move. `null` for Maia3, which returns no score. |
| `depth`       | `int \| null`    | Search depth.                                                               |
| `elapsed_sec` | `float`          | Wall-clock seconds spent.                                                   |
| `ponder`      | `string \| null` | Predicted reply, when the bot offers one.                                   |
| `is_mate`     | `bool`           | Whether the score is a forced mate.                                         |
| `mate_in`     | `int \| null`    | Moves to mate.                                                              |

**Total failure is normalized too.** If no bot can move, the response is
`{"move": null, "san": null, ...}` with the rest of the shape intact — not a
short error dict — so a caller destructuring the result never hits a
missing key.

### Search budget

Think time is resolved **once per move** by the manager, from the clock and the
think profile, and handed unchanged to whichever bot plays. This is what makes
bots comparable: switching from Stockfish to Mentor for the same position
changes _how_ the move is chosen, not _how long_ it was allowed to think.
Budgets are clamped to 0.01–5.0 s.

---

## State snapshot

Most game commands return the same full snapshot. `new_game`, `make_move`,
`resign`, `draw`, `undo_move`, `navigate_to_move` and `import_pgn` all return
this shape (plus `last_move_san` where a move was just played):

```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
  "turn": "black",
  "legal_moves": ["e7e5", "c7c5", ...],
  "move_history": ["e4", ...],
  "full_move_history": ["e2e4", ...],
  "move_colors": ["white", ...],
  "last_move_san": "e4",
  "last_move_uci": "e2e4",
  "nav_index": -1,
  "game_over": false,
  "result": null,
  "termination": null,
  "in_check": false,
  "clock": { "white_ms": 600000, "black_ms": 598250, "increment_ms": 0 }
}
```

| Field               | Meaning                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `move_history`      | SAN per ply, replayed from the retained start position.                                                |
| `full_move_history` | UCI per ply, from the same single replay — the two arrays cannot desynchronise.                        |
| `move_colors`       | The side that **moved** each ply (`board.turn` before the push), never index parity.                   |
| `nav_index`         | `-1` means the live position; anything else is a history viewing window.                               |
| `result`            | `"1-0"`, `"0-1"`, `"1/2-1/2"`, or `null` while the game is live. The backend latches this, not the UI. |
| `termination`       | How the game ended (see below), or `null` while live.                                                  |
| `clock`             | Remaining time per side (see below), or `null` when the game is Unlimited.                             |

### Termination vocabulary

Board outcomes come from `python-chess` (`CHECKMATE`, `STALEMATE`,
`INSUFFICIENT_MATERIAL`, `SEVENTYFIVE_MOVES`, `FIVEFOLD_REPETITION`,
`VARIANT_WIN`, `VARIANT_LOSS`, `VARIANT_DRAW`). Three more are latched by the
backend when the board itself is not over:

| `termination`    | `result`                   | Set by                                       |
| ---------------- | -------------------------- | -------------------------------------------- |
| `TIME_FORFEIT`   | `"1-0"` / `"0-1"` (winner) | Flag-fall: the side to move ran out of time. |
| `RESIGN`         | `"1-0"` / `"0-1"` (winner) | `resign`: `side` names the **losing** side.  |
| `DRAW_AGREEMENT` | `"1/2-1/2"`                | `draw`: the players agreed.                  |

`TIME_FORFEIT` is a backend custom string, not a `python-chess` member
(python-chess 1.11.2 has no time member in its `Termination` enum); the
codebase vocabulary is SCREAMING so the custom value follows suit.

### The `clock` object

```json
{ "white_ms": 600000, "black_ms": 598250, "increment_ms": 0 }
```

All fields are whole-millisecond ints. Elapsed thinking time for the side to
move is applied live on every read and clamped at 0, so a snapshot is never
internally inconsistent (no negative time, always the correct side debited).
The stamp is `time.monotonic`, not wall clock, so NTP/DST/manual changes can
neither flag falsely nor grant free time. When the game is Unlimited
(`time_control` absent or `seconds <= 0`) the snapshot carries
`"clock": null` — no clock installed, no flag possible.

---

## Commands

### `new_game`

Start a new game, reset the board, and (re-)arm the game clock.

**Request params:**

```json
{
  "mode": "human_vs_ai",
  "engine_type": "mentor",
  "human_color": "white",
  "strength": 7,
  "time_control": { "seconds": 600, "increment": 0 },
  "fen": null
}
```

`time_control` is consumed by the backend (P3-T01): `{"seconds": N,
"increment": I}` installs N seconds per side plus an I-second increment,
resetting both clocks and clearing any latched result. `seconds <= 0` or an
absent control means **Unlimited** — both clocks are cleared to `null` so no
flag can ever latch, and any running `clock_tick` loop stops. A live clock
starts a 1 Hz `clock_tick` push loop (see [Push events](#push-events)) so the
renderer needs no client-side timer.

The engine numerics (`threads`, `hash_mb`, `multipv`, `maia3_elo`) are clamped
at the IPC boundary through the canonical schema (`backend/settings_schema.py`:
8 threads / 512 MB / 5 multipv max) — junk like `threads: 99999` becomes the
cap here, before the engine stores anything. Only keys **present** are touched;
absent keys stay absent. `fen` is an optional custom start position (e.g. a
black-to-move load); absent means the standard startpos.

**Response result:** full state snapshot (see [State snapshot](#state-snapshot)).

---

### `make_move`

Push a UCI move onto the board.

**Request params:**

```json
{ "move": "e2e4" }
```

**Response result:** Full state snapshot (same as `new_game` result plus history fields).

The mover's elapsed thinking time is debited **before** the move is applied,
then the increment is added. A debit to ≤ 0 latches the terminal result
(`TIME_FORFEIT`) and skips the increment — a flagged player earns no bonus
time — while the move itself is still applied. A move is rejected — with the guard `reason` surfaced as the error,
not a bare `Illegal move` — while history is being browsed (return to the
live position first) or when the game is already over.

---

### `resign`

Record a resignation. The backend is the single termination authority: only
it can end a game, so the renderer never sets a result locally.

**Request params:**

```json
{ "side": "white" }
```

`side` is the **losing** side (`"white"` or `"black"`).

**Response result:** full state snapshot with `result` set to the winner
(`"0-1"` when white resigns, `"1-0"` when black resigns) and `termination`
`"RESIGN"`.

**Errors:** an unknown `side`, or a game that is already over
(`"Game is already over"`).

---

### `draw`

Record an agreed draw.

**Request params:** `{}` (ignored)

**Response result:** full state snapshot with `result` `"1/2-1/2"` and
`termination` `"DRAW_AGREEMENT"`.

**Errors:** a game that is already over (`"Game is already over"`).

---

### `get_legal_moves`

Get all legal moves for a position.

**Request params:**

```json
{ "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1" }
```

**Response result:**

```json
{
  "moves": [
    { "uci": "e7e5", "san": "e5", "from": "e7", "to": "e5", "promotion": null },
    ...
  ]
}
```

---

### `undo_move`

Pop the last move from the stack.

**Request params:** `{}`

**Response result:** State snapshot.

Undo reopens a latched game: a flag/resign/draw latch clears so the position
is live again. Time spent stays spent — only the latch clears — and the turn
clock restarts now, so the side to move is not instantly re-flagged.

---

### `navigate_to_move`

Navigate history to a specific move index without modifying the game.

**Request params:**

```json
{ "index": 5 }
```

**Response result:** State snapshot at that position.

---

### `get_engine_move`

Get a move for a position. This is the general engine entry point and accepts
**any** bot id, not just Stockfish.

**Request params** (all optional except a usable `fen`):

```json
{
  "fen": "<FEN>",
  "engine_type": "mentor",
  "time_limit": 0.5,
  "depth": null,
  "strength": 7,
  "stockfish_path": null,
  "threads": null,
  "hash_mb": null,
  "maia3_path": null,
  "maia3_model": "maia3-5m",
  "maia3_device": "auto",
  "maia3_elo": 1500,
  "think_profile": "human_like",
  "time_remaining": null,
  "time_increment": null,
  "total_moves": null
}
```

`engine_type` is a `bot_id` from `list_bots`, or `auto` to let the manager
choose. `stockfish_path` overrides the configured path **for this move only**,
which is how an explicit `stockfish-19` selection stays pinned to that build.

**Response result:** the standard move result (see [The Bot Model](#the-bot-model)).

---

### `get_bot_move`

Get a bot's move. Functionally equivalent to `get_engine_move` — it delegates
to the same manager path — and kept because the renderer calls it. Prefer
`get_engine_move` in new code.

**Request params:**

```json
{ "fen": "<FEN>", "engine_type": "mentor", "strength": 7 }
```

`strength` is the shared 1–10 cross-bot scale, clamped to that range.

**Response result:** the standard move result.

---

### `list_bots`

The bots this install can actually run, with availability and capabilities. The
UI renders this instead of hard-coding engine names, so a newly discovered
Stockfish build or a bot added later appears without frontend changes.

**Request params:** `{}` (ignored)

**Response result:**

```json
{
  "bots": [
    {
      "bot_id": "mentor",
      "display_name": "Mentor",
      "kind": "builtin",
      "description": "Instant in-process search. Always available, but shallow.",
      "requires_binary": false,
      "supports_skill_level": true,
      "supports_elo": false,
      "supports_eval": true,
      "deterministic": true,
      "available": true,
      "is_default": true
    },
    {
      "bot_id": "stockfish-19",
      "display_name": "Stockfish 19",
      "kind": "uci",
      "description": "Deepest search of the available bots; limited by engine speed.",
      "requires_binary": true,
      "supports_skill_level": true,
      "supports_elo": false,
      "supports_eval": true,
      "deterministic": true,
      "available": true,
      "is_default": false
    },
    {
      "bot_id": "maia3",
      "display_name": "Maia3",
      "kind": "uci",
      "description": "Plays like a human of a chosen Elo. Sampled, and returns no score.",
      "requires_binary": false,
      "supports_skill_level": false,
      "supports_elo": true,
      "supports_eval": false,
      "deterministic": false,
      "available": false,
      "is_default": false
    }
  ]
}
```

| Field                  | Meaning                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`                 | `builtin` (in-process) or `uci` (subprocess / proxy).                                                                                |
| `requires_binary`      | Needs a discovered executable to be available.                                                                                       |
| `supports_skill_level` | Honors the cross-bot 1–10 strength scale (Stockfish maps it onto its native UCI `Skill Level`; Mentor maps it onto its own search config). False only for bots with their own scale, e.g. Elo-driven Maia3. |
| `supports_elo`         | Configurable by Elo rating (Maia3).                                                                                                  |
| `supports_eval`        | Can return a score. False for Maia3, so callers must not require one.                                                                |
| `deterministic`        | False for Maia3, which samples from a distribution.                                                                                  |
| `available`            | Whether it can play right now. Unavailable bots appear but are disabled in the UI.                                                   |
| `is_default`           | The fallback used when nothing else is specified (currently `mentor`).                                                               |

> Discovery starts engines, so the first `list_bots` after launch is not
> instant. The UI tracks a separate "still looking" state so a slow scan is not
> shown as "no engine installed".

---

### `settings_defaults`

The canonical settings defaults, limits and schema version
(`backend/settings_schema.py` is the single authority — the 8-thread /
512 MB / 5-multipv caps live there, not in the UI).

**Request params:** `{}` (ignored — there is nothing to pass)

**Response result:**

```json
{
  "schemaVersion": 1,
  "defaults": {
    "threads": 1,
    "hash_mb": 128,
    "multipv": 3,
    "strength": 7,
    "think_profile": "human_like",
    "maia3_elo": 1500,
    "stockfish_path": "stockfish",
    "maia3_model": "maia3-5m",
    "maia3_device": "cpu"
  },
  "limits": {
    "min_threads": 1,
    "max_threads": 8,
    "min_hash_mb": 16,
    "max_hash_mb": 512,
    "min_multipv": 1,
    "max_multipv": 5
  }
}
```

The renderer treats this payload as the authority: `loadFromBackend`
(`renderer/src/stores/settingsStore.ts`) fetches it over the wired
`settings_defaults` channel (preload `getSettingsDefaults` → main
`CHESS_COMMANDS` entry) and applies backend defaults under saved values
through the same validation `update` uses. Static fallback constants (8 threads
/ 512 MB / 5 multipv, `schemaVersion` 1) cover boot only when the backend is
unreachable — boot never blocks on the backend.

---

### `get_eval`

Score the current position with Mentor's built-in evaluation (no Stockfish
needed). The evaluation bar in Human vs Mentor mode uses this.

**Request params:**

```json
{ "fen": "<FEN>", "use_mentor_eval": true }
```

Set `use_mentor_eval` to `false` to skip custom evaluation.

**Response result:**

```json
{ "eval_cp": 0, "phase": 0 }
```

`phase` runs 0–256 from opening to endgame (see `MentorEngine._phase`).
The former `mg_score` / `eg_score` fields were dropped in P2-T12: both
were identical raw-material sums (KING=20000-dominated) that no consumer
read; the blended `eval_cp` is the authoritative score.

---

### `export_pgn`

Export the current game as a PGN string.

**Request params:** `{}`

**Response result:**

```json
{ "pgn": "[Event \"Aether Chess Game\"]\n[Site \"?\"]\n..." }
```

---

### `import_pgn`

Load a game from PGN text.

**Request params:**

```json
{ "pgn": "[Event \"...\"]\n..." }
```

**Response result:** State snapshot after importing.

---

### `export_fen`

Get the current position as FEN.

**Request params:** `{}`

**Response result:**

```json
{ "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1" }
```

---

### `get_book_moves`

Query the Polyglot opening book for moves at a position.

**Request params:**

```json
{ "fen": "<FEN>", "books_dir": "resources/books" }
```

**Response result (book found):**

```json
{
  "moves": [
    { "uci": "e7e5", "san": "e5", "weight": 4200 },
    { "uci": "c7c5", "san": "c5", "weight": 1800 }
  ]
}
```

**Response result (no book):**

```json
{
  "moves": [],
  "hint": "No opening book found. Place .bin files in the books directory."
}
```

---

### `probe_tablebase`

Syzygy endgame probe (P4-T01). Detect-and-report: when no tablebase path is
configured it answers `configured: false` instead of failing, so the UI
degrades to a quiet note.

**Request params:**

```json
{ "fen": "<FEN>", "tablebase_path": "/home/user/syzygy/3-4-5" }
```

`fen` is optional — absent means the live board (read under the board lock).
`tablebase_path` accepts the camelCase alias `tablebasePath`; absent or empty
means unconfigured. Both are shape-checked at the `ipcMain.handle` boundary
(`electron/ipcValidation.ts`).

**Response result (unconfigured):**

```json
{ "configured": false, "best_move": null, "fen": "<FEN>" }
```

**Response result (configured):**

```json
{ "configured": true, "best_move": "e8e7", "fen": "<FEN>" }
```

`best_move` is UCI, or `null` when the probe finds nothing (including
positions with more than 6 pieces, which return `reason: "too many pieces"`).
Missing tables / OS errors map to `null`, never a raise — only an invalid FEN
raises (`ValueError`, same surface as the other FEN-taking handlers).

**Wiring:** `service.py:handle_probe_tablebase` → `HANDLERS["probe_tablebase"]`,
forwarded by main's generic `CHESS_COMMANDS` loop (`electron/main.ts`), exposed
as preload `probeTablebase` (+ `renderer/src/electron.d.ts`). UI: the
SettingsPanel tablebase-directory picker persists `tablebasePath`
(`renderer/src/stores/settingsStore.ts`), and `TablebaseAnnotation`
(`renderer/src/components/AnalysisPanel.tsx`) probes per position. No
tablebase data ships in the repo — see [SETUP](SETUP.md#5b-add-syzygy-endgame-tablebases-optional-p4-t01)
for the download and layout.

---

### `start_analysis`

Start streaming engine analysis (returns immediately; updates pushed as events).

**Request params:**

```json
{ "fen": "<FEN>", "multipv": 3, "callback_id": "my-analysis-1" }
```

**Response result:**

```json
{ "started": true }
```

**Push events (no id):**

```json
{
  "type": "analysis_update",
  "callback_id": "my-analysis-1",
  "pvs": [
    { "depth": 22, "score_cp": 42, "mate": null, "pv": ["e2e4", ...], "pv_san": ["e4", ...] }
  ],
  "fen": "<FEN>"
}
```

---

### `stop_analysis`

Stop an ongoing analysis.

**Request params:** `{}`

**Response result:**

```json
{ "stopped": true }
```

---

## Push events

Id-less messages the backend pushes at any time (forwarded by main to every
live window — no per-window subscription, every window shows the same game).

### `analysis_update`

Streamed principal variations for a `start_analysis` request (see
[`start_analysis`](#start_analysis) for the shape).

### `clock_tick`

A full state snapshot forwarded at 1 Hz while a game clock runs — the PUSH
tick source P3-T01 chose over polling, so the renderer keeps no client-side
timer (the old `setInterval` is gone; the UI renders `store.clock`):

```json
{
  "type": "clock_tick",
  "fen": "<FEN>",
  "turn": "white",
  "clock": { "white_ms": 598250, "black_ms": 600000, "increment_ms": 0 },
  "game_over": false,
  "result": null,
  "termination": null,
  "...": "every other state-snapshot field"
}
```

The loop starts on `new_game` with a live clock (restarting replaces any
previous loop — only one runs at a time) and stops when the game is Unlimited,
when `import_pgn` clears the clock, or once a terminal snapshot has been
delivered. A player who sits idle without moving is still flagged: the flag
check runs at the top of every snapshot, so the next tick latches
`TIME_FORFEIT` by itself.

---

### `calculate_accuracy`

Post-game accuracy scoring (requires Stockfish, may take several minutes).

**Request params:**

```json
{
  "fen_list": ["<FEN before move 1>", "<FEN before move 2>", ...],
  "moves": ["e2e4", "e7e5", ...],
  "stockfish_path": "stockfish"
}
```

**Response result:**

```json
{
  "moves": [
    { "uci": "e2e4", "fen": "...", "color": "white", "cp_loss": 0.0, "classification": "Best" },
    ...
  ],
  "white_accuracy": 87.4,
  "black_accuracy": 79.1
}
```

---

### `estimate_elo`

Estimate Elo rating from accuracy metrics.

**Request params:**

```json
{
  "accuracy": 87.4,
  "blunder_rate": 0.05,
  "avg_cp_loss": 0.0,
  "num_games": null
}
```

`avg_cp_loss` and `num_games` are optional. `num_games` is an IPC-fed loop
bound (`range(estimated_games)` in `backend/analysis.py`), so it is clamped
to at most 100 — a huge value would be a CPU-DoS vector in the handler thread.
Values `< 1` normalize to `null` (the accuracy heuristic path owns them) and
non-numeric input is rejected with `Invalid num_games`.

**Response result:**

```json
{
  "estimated_elo": 1490,
  "confidence_interval": [1098, 1892],
  "rd": 200.0,
  "rating_deviation": 200.0,
  "games_simulated": 22
}
```

`rd` and `rating_deviation` are the same value under two names — `rd` is the
Bayesian posterior deviation, and the interval widens with it. A rating
estimated from very few simulated games is close to meaningless, so read
`games_simulated` alongside it.

---

### `calculate_accuracy_from_history`

Score the current game's accuracy from moves already played, without replaying
the game. Cheaper than `calculate_accuracy` because no fresh Stockfish analysis
is run.

**Request params:**

```json
{ "moves": ["e2e4", "e7e5", "g1f3", "..."] }
```

**Response result:** same shape as `calculate_accuracy`.

---

### `calculate_accuracy_from_pgn`

Score an imported game. Runs the full analysis, so it can take a while.

**Request params:**

```json
{ "pgn": "[Event \"...\"]\n...", "stockfish_path": "stockfish" }
```

**Response result:** same shape as `calculate_accuracy`.

---

### `export_pdf_report`

PDF game report (P4-T02). Builds on the same Stockfish accuracy rows as
`calculate_accuracy_from_pgn`, so it needs Stockfish and can take minutes
(long-running IPC tier, 300 s timeout).

**Request params:**

```json
{ "pgn": "[Event \"...\"]\n...", "stockfish_path": "stockfish" }
```

`pgn` is optional — absent means the live game (history snapshot taken under
the board lock, then released before the long computation, mirroring
`calculate_accuracy_from_history`). Optional display overrides `white`,
`black`, `result` (default from PGN headers, else `White` / `Black` / `*`).
`output_path` is **not** a renderer param: main's dedicated `export-pdf-report`
handler injects a history-dir destination (overwriting any supplied value) and
the renderer reveals it via the existing `reveal-in-folder` IPC — no new shell
surface. Without main (direct backend use) it falls back to a temp file.

**Response result:**

```json
{
  "path": "/home/user/.config/AetherChess/games/report-....pdf",
  "key_moments": ["Ply 6 Nf6 (black, Blunder, cp loss 520.0)", "..."]
}
```

`key_moments` is the top-5 `cp_loss` rows (`KEY_MOMENTS_TOP_N = 5` in
`aether_chess/analysis/reporting.py`), each replayed from its own `fen`+`uci`.
Side accuracies come from `accuracy_from_losses` on each side's own losses;
side Elos from `estimate_elo` on the same per-side numbers.

**Errors:** unparseable PGN → `ValueError`; an accuracy-backend error → the
same error as `ValueError`; an unwritable path → `OSError` naming the path;
missing `fpdf2` → `RuntimeError` (defensive — `fpdf2` is a hard requirement
since P4-T02, and the module uses core fonts only so no font file is ever
loaded).

**Wiring:** `service.py:handle_export_pdf_report` → `HANDLERS["export_pdf_report"]`
— **not** in main's `CHESS_COMMANDS` loop but a dedicated `export-pdf-report`
handler (it must inject `output_path`), validated at the boundary, exposed as
preload `exportPdfReport` (+ `electron.d.ts`). UI: the AnalysisView
`handleExportPdf` action (`renderer/src/views/AnalysisView.tsx`) calls it for
the live game, reveals the file, and toasts; the AnalysisPanel `Export PDF`
button is props-drilled like `onComputeAccuracy` with matching loading/error
states.

---

### `check_maia3_cache`

Whether a Maia3 model is already downloaded, so the UI can avoid starting a
download the user cannot see progress for.

**Request params:**

```json
{ "model": "maia3-5m" }
```

Valid `model` values are `maia3-5m`, `maia3-23m`, `maia3-79m`.

**Response result:**

```json
{ "cached": true, "model": "maia3-5m" }
```

---

### `maia3_cache`

Download a Maia3 model into the Hugging Face cache.

**Request params:**

```json
{
  "model": "maia3-5m",
  "cache_dir": null,
  "force_download": false,
  "hf_token": null
}
```

Set `hf_token` for gated repos. `HF_HOME` is honoured; it defaults to
`~/.cache/huggingface`.

**Response result:**

```json
{ "ok": true, "model": "maia3-5m" }
```

> Progress is written to **stderr**, not stdout. The backend wraps the
> downloader because `cache.py` prints to stdout, which would corrupt the
> newline-delimited JSON protocol. The UI streams this to the terminal only —
> see [TODO](../TODO.md) item 1 for the in-app progress bar.

**Error:** if Maia3 is not installed in the environment, this returns
`"Maia3 is not installed in this environment. Run: python -m pip install -e ./inspiration"`.

---

## Threading & Concurrency

Every request is submitted to a bounded pool (`ThreadPoolExecutor`,
`max_workers=8`), so **reading stdin is never blocked** and the UI stays
responsive even while an engine is thinking.

Commands are then grouped by what they need:

| Group           | Commands                                                                                                                                                                                      | Locking                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Board mutation  | `new_game`, `make_move`, `resign`, `draw`, `undo_move`, `navigate_to_move`, `import_pgn`                                                                                                      | Serialized under one board lock, so the game state cannot be corrupted by interleaving.                                    |
| Board read      | `get_legal_moves`, `export_pgn`, `export_fen`, `get_book_moves`, `probe_tablebase`                                                                                                                                 | Same board lock, but fast. (`probe_tablebase` takes it only to read the live FEN when no `fen` is passed.)                 |
| Everything else | `get_engine_move`, `get_bot_move`, `list_bots`, `settings_defaults`, `get_eval`, `calculate_accuracy*`, `export_pdf_report`, `estimate_elo`, `start_analysis`, `stop_analysis`, `maia3_cache`, `check_maia3_cache` | **No board lock.** These take a FEN from params and may block for a long time, so holding the lock would freeze the board. |

`new_game` stops analysis _before_ taking the board lock, so waiting on
analysis teardown cannot block board traffic.

Engine searches are serialized under a separate `_uci_lock`, held for the
whole search — `python-chess` handles are not safe for concurrent use, so two
overlapping `get_engine_move` calls queue instead of interleaving the UCI
protocol and corrupting replies. (Lock order is board-outer / UCI-inner; in
practice no path holds both at once — handlers snapshot the FEN under the
board lock, release it, then take the UCI lock for the search.)
