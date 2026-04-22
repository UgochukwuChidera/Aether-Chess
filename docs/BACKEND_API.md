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

Get Stockfish's best move for a position.

**Request params:**
```json
{
  "fen": "<FEN>",
  "time_limit": 0.5,
  "depth": null
}
```

**Response result:**
```json
{ "move": "e7e5", "san": "e5" }
```

---

### `get_bot_move`

Get the Aether mentor bot's move.

**Request params:**
```json
{ "fen": "<FEN>", "strength": 7 }
```

**Response result:**
```json
{ "move": "g8f6", "san": "Nf6" }
```

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
  "hint": "No opening book loaded. Place a .bin file in the books directory."
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
  "estimated_elo": 1642,
  "confidence_interval": [1420, 1864],
  "rd": 114.2
}
```

---

## Threading & Concurrency

- All commands **except** `start_analysis` and `stop_analysis` are executed under a single threading lock to prevent board-state corruption.
- `start_analysis` spawns a daemon thread; analysis updates are pushed to stdout independently.
- The backend handles **one chess request at a time** from the lock's perspective — the frontend should not fire concurrent game-state commands.
