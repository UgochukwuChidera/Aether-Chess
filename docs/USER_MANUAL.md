# Aether Chess — User Manual

## Getting Started

Launch Aether Chess. The **Play** tab opens automatically with the board ready.

---

## Starting a New Game

1. Use the **New Game Setup** panel at the bottom of the Play tab to choose your settings.
2. **Mode** — pick Human vs AI, Human vs Human, or AI vs AI.
3. **Play as** — choose White, Black, or Random (hidden for AI vs AI).
4. Press **New Game** to apply your selection and start.

> Your opponent is chosen in **Settings → Engine → Play engine**, not here. That
> setting carries across new games, so you pick an engine once and start as many
> games as you like.

White pieces are at the bottom by default. Press **Flip** or `F` to swap perspectives.

### Game Modes

| Mode | Description |
|------|-------------|
| Human vs AI | You play against the bot selected in Settings |
| Human vs Human | Two players take turns on the same device |
| AI vs AI | Watch the engine play both sides (no human input) |

> **Human vs AI — playing Black:** the engine automatically makes the first move as White before you can interact with the board.

> **AI vs AI:** resign and draw controls are hidden; use **New Game** to stop the demonstration.

---

## Making Moves

1. **Click** a piece to select it — valid destination squares will be highlighted.
2. **Click** a highlighted square to move.
3. If a pawn reaches the back rank, a **Promotion Dialog** appears — select your piece.
   - Enable **Auto-queen** in Settings to skip this dialog.

---

## Game Controls

| Button | Action |
|--------|--------|
| Flip | Rotate the board 180° |
| Undo | Take back the last move |
| Draw | Offer a draw (engine will decline) |
| Resign | Forfeit the game |

---

## Move History

The scrollable list below the board shows all moves in algebraic notation (SAN):
- **White moves** on the left column, **black moves** on the right.
- The current position is highlighted with a green left border.
- **Click any move** to navigate to that position without modifying the game.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Flip board |
| `←` | Navigate back one move |
| `→` | Navigate forward one move |
| `Ctrl+Z` | Undo last move |
| `Ctrl+C` | Copy PGN to clipboard |

---

## Analysis Tab

1. Switch to the **Analysis** tab.
2. Press **Analyse** to start Stockfish evaluation on the current position.
3. Up to 3 principal variation (PV) lines are shown with depth and score.
4. Press **Stop** to halt analysis.
5. Navigate through moves — analysis restarts on the new position.

### Move Classifications

| Label | Centipawn loss |
|-------|---------------|
| Best | 0–15 cp |
| Great | 15–35 cp |
| Inaccuracy | 35–75 cp |
| Mistake | 75–150 cp |
| Blunder | > 150 cp |

---

## Evaluation Bar

The horizontal bar above the board shows:
- **Light gray** — white's share of advantage
- **Dark gray** — black's share
- **Glowing green segment** — current evaluation point

Scores are in centipawns (cp). `+1.00` = one pawn advantage for white. `M5` = forced mate in 5.

---

## Settings

Access via the **Settings** tab or the gear icon in the top bar.

### Appearance
- Switch between **Dark**, **Light**, and **High Contrast** themes.
- **Board style** — choose from 8 palettes: Classic, Wood, Marble, Neon, Ice, Forest, Tournament, Aether.
- **Piece set** — Material Symbols (font icons), Alpha (outline Unicode), or Neo (coloured Unicode with gold White / dark Black).
- Adjust animation speed.

### Engine

#### Play engine

The **Play engine** dropdown lists every bot this install can actually run. The
list is built by the app from what it finds on your machine, so it changes with
your setup rather than being fixed.

| Entry | What it is |
|-------|------------|
| **Mentor** | Built-in engine. Always available, no install, plays instantly. Default. |
| **Stockfish** | Your configured Stockfish build. |
| **Stockfish 18**, **Stockfish 19**, … | One entry per build found in `engines/`. Pick one to pin that exact version. |
| **Maia3** | Neural bot that plays like a human of a chosen Elo. Needs its model downloaded first. |

A bot that cannot run right now still appears, marked **(unavailable)** and
greyed out — for example Maia3 before its model is downloaded. Mentor is never
unavailable, so there is always something to play against.

If the list says **Could not load the bot list**, the app could not reach its
own backend. Restart the app; if it persists, see [docs/SETUP.md](SETUP.md).

#### Engine tuning

- Set the path to your Stockfish executable.
- Configure thread count and hash memory.
- Set Multi-PV lines for analysis (1–5).
- Adjust mentor bot difficulty (1–10) — a global strength scale that applies to
  whichever bot you pick.
- Maia3 Elo (e.g. 1500) and device, when Maia3 is selected.

> **Mentor difficulty** changes the depth, node budget, transposition table and
> move sampling that Mentor searches with. At 10 it always plays its best move;
> at lower levels it samples weaker moves so it can be beaten.

#### Memory presets

| Hardware tier | Recommended Hash | Recommended Threads |
|---------------|-----------------|---------------------|
| Low-end PC    | 64 MB           | 1                   |
| Mid-range     | 256 MB          | 2                   |
| High-end      | 512 MB          | 4+                  |

> Maximum allowed values: **2048 MB** hash, **64 threads**.  
> A warning appears in Settings when hash exceeds 512 MB.

### Gameplay
- Choose time control (Blitz, Rapid, Classical, Unlimited).
- Toggle auto-queen promotion.
- Toggle sound and adjust volume.

### Data
- Export all settings to a JSON file.
- Import settings from a previously exported file.

---

## Opening Explorer

If a Polyglot `.bin` book file is present in `resources/books/`, the opening explorer shows available book moves when querying the current position. The app works without a book — this feature gracefully degrades.

---

## Exporting Games

- **Copy PGN** — copies the full game PGN to your clipboard.
- PGN includes standard headers and can be imported into any chess program.

---

## Timers

- **Opponent timer** — neutral gray background.
- **Your timer** — highlighted in primary green with a glow when active.
- Time control is set in **Settings → Gameplay**.
- Select **Unlimited** for untimed play.
