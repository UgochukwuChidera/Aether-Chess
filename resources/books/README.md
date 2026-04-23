# Opening Books Guide

## Overview
This folder should contain Polyglot opening book files in `.bin` format.
The Aether Chess app reads these files to provide opening move suggestions
during the opening phase (first ~20 plies = 10 moves each side).

## File Format
- **Format**: Polyglot binary (.bin)
- **Naming**: Any .bin file in this folder is auto-detected
- **Example**: `perfect2023.bin`, `gm_main.bin`

## Where to Get Opening Books

### Option 1: Download Pre-made Books (Easiest)
Search for "polyglot opening book download" online. Some sources:
- **Syzygy / OpenBench** repositories often include starter books
- **Fishnet** and **Lozza** projects publish sample books
- **TuneUp** and **CCRL** groups have public books (check their download pages)

Important: Choose books with permissive licensing (open source, CC0, or public domain).

### Option 2: Generate Your Own from PGN
If you have a collection of PGN games (e.g., from TWIC, Lichess database):

1. **Get PGN files** with games you want to learn from
2. **Use a polyglot builder tool**. Example tools:
   - `polyglot-book-create` (command line, search on GitHub)
   - `pgn2bin` (Python script)
   
   Example (if using polyglot-book-create):
   ```
   polyglot-book-create my_games.pgn -o my_book.bin -d 15
   ```
   - `-d 15` = max depth (plies) to include

3. **Drop the .bin file** into this folder

### Option 3: Use Stockfish's Built-in Book
Stockfish includes a default book (.bin). You can extract it:
- Search for "stockfish book.bin" in the Stockfish source or releases
- Copy it to this folder

## Troubleshooting
- **"No book found"**: Make sure you have .bin files in this folder
- **Zero moves**: The book may not contain your position. Try another book or generate a deeper one
- **Slow moves**: Use a smaller book (fewer entries = faster)

## File Structure (for developers)
The backend uses `chess.polyglot.open_reader()` to read these files.
See `backend/chess_engine.py:get_book_moves()` for implementation details.
