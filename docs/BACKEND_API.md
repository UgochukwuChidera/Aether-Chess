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

## Commands

### `new_game`

Start a new game and reset the board.

**Request params:**

```json
{
  "mode": "human_vs_ai",
  "engine_type": "mentor",
  "human_color": "white",
  "strength": 7,
  "time_control": { "seconds": 600, "increment": 0 }
}
```

**Response result:**

```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "turn": "white",
  "legal_moves": ["e2e4", "d2d4", ...],
  "game_over": false
}
```

---

### `make_move`

Push a UCI move onto the board.

**Request params:**

```json
{ "move": "e2e4" }
```

**Response result:** Full state snapshot (same as `new_game` result plus history fields).

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
      "supports_skill_level": false,
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
| `supports_skill_level` | Exposes a **native UCI `Skill Level` option**. False for Mentor, whose 1–10 strength is Aether's own scale rather than a UCI option. |
| `supports_elo`         | Configurable by Elo rating (Maia3).                                                                                                  |
| `supports_eval`        | Can return a score. False for Maia3, so callers must not require one.                                                                |
| `deterministic`        | False for Maia3, which samples from a distribution.                                                                                  |
| `available`            | Whether it can play right now. Unavailable bots appear but are disabled in the UI.                                                   |
| `is_default`           | The fallback used when nothing else is specified (currently `mentor`).                                                               |

> Discovery starts engines, so the first `list_bots` after launch is not
> instant. The UI tracks a separate "still looking" state so a slow scan is not
> shown as "no engine installed".

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
{ "accuracy": 87.4, "blunder_rate": 0.05 }
```

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

Every request is dispatched to its own daemon thread, so **reading stdin is
never blocked** and the UI stays responsive even while an engine is thinking.

Commands are then grouped by what they need:

| Group           | Commands                                                                                                                                                                 | Locking                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Board mutation  | `new_game`, `make_move`, `undo_move`, `navigate_to_move`, `import_pgn`                                                                                                   | Serialized under one board lock, so the game state cannot be corrupted by interleaving.                                    |
| Board read      | `get_legal_moves`, `export_pgn`, `export_fen`, `get_book_moves`                                                                                                          | Same board lock, but fast.                                                                                                 |
| Everything else | `get_engine_move`, `get_bot_move`, `list_bots`, `get_eval`, `calculate_accuracy*`, `estimate_elo`, `start_analysis`, `stop_analysis`, `maia3_cache`, `check_maia3_cache` | **No board lock.** These take a FEN from params and may block for a long time, so holding the lock would freeze the board. |

`new_game` stops analysis _before_ taking the board lock, so waiting on
analysis teardown cannot block board traffic.

Because non-board commands are not serialized, **do not fire two
`get_engine_move` calls concurrently** — they will compete for CPU and the
same Stockfish binary. Board commands remain safe to send in any order.
