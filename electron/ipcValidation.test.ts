/**
 * Unit tests for the IPC payload validators (P3-T03).
 *
 * Fail-first contract: `electron/ipcValidation.ts` does not exist yet, so
 * `npm run test:electron` fails at the `tsc -p tsconfig.test.json` step
 * (TS2307: cannot find module './ipcValidation') before any assertion runs.
 * Same precedent as P2-T06 (`shellPolicy.ts`).
 *
 * Design note: the validators live in a zero-electron-dep pure module
 * (P0-T09 precedent — `main.ts` imports `electron` and throws under plain
 * Node). The ipcMain handlers stay thin: validate → throw on fail (the same
 * throw-so-invoke-rejects convention as the P2-T06 shell guards), else
 * forward byte-identically. Unknown/extra keys are IGNORED, never rejected
 * (forward-compat). No FEN/UCI chess-semantics checks here — the backend
 * owns chess truth and already raises Illegal move; this is about garbage.
 *
 * Runs under plain Node (no Electron).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { validateIpcParams } from "./ipcValidation";

// null means "valid, forward it"; a string is the field-naming error.
function assertValid(command: string, params: unknown): void {
  assert.equal(validateIpcParams(command, params), null);
}

function assertInvalid(command: string, params: unknown, field: string): void {
  const err = validateIpcParams(command, params);
  assert.ok(
    typeof err === "string",
    `expected ${command} to reject ${String(params)}`,
  );
  assert.ok(
    err.includes(field),
    `error ${JSON.stringify(err)} should name field '${field}'`,
  );
}

const STARTPOS = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("validateIpcParams plumbing", () => {
  it("rejects non-object params for structured commands", () => {
    for (const bad of [null, undefined, 42, "e2e4", []]) {
      assertInvalid("make_move", bad, "params");
    }
  });

  it("names the command in the error", () => {
    const err = validateIpcParams("make_move", {});
    assert.ok(typeof err === "string" && err.includes("make_move"));
  });

  it("passes unknown commands through (forward-compat)", () => {
    assertValid("some_future_command", { anything: [1, "two", null] });
  });

  it("passes no-param commands with any payload (no rule)", () => {
    for (const cmd of [
      "draw",
      "undo_move",
      "list_bots",
      "export_pgn",
      "export_fen",
      "stop_analysis",
    ]) {
      assertValid(cmd, {});
      assertValid(cmd, undefined);
      assertValid(cmd, { unexpected: "keys are ignored" });
    }
  });
});

describe("make_move", () => {
  it("rejects missing/empty/non-string move", () => {
    assertInvalid("make_move", {}, "move");
    assertInvalid("make_move", { move: "" }, "move");
    assertInvalid("make_move", { move: 1234 }, "move");
    assertInvalid("make_move", { move: null }, "move");
  });

  it("passes the real renderer shape, extra keys ignored", () => {
    assertValid("make_move", { move: "e2e4" });
    assertValid("make_move", { move: "e7e8q", extra: "ignored" });
  });
});

describe("resign", () => {
  it("rejects missing/garbage side", () => {
    assertInvalid("resign", {}, "side");
    assertInvalid("resign", { side: "" }, "side");
    assertInvalid("resign", { side: "green" }, "side");
    assertInvalid("resign", { side: 0 }, "side");
  });

  it("passes white/black", () => {
    assertValid("resign", { side: "white" });
    assertValid("resign", { side: "black" });
  });
});

describe("get_legal_moves / get_eval / get_book_moves", () => {
  it("rejects non-string fen, allows absent/empty (board fallback)", () => {
    for (const cmd of ["get_legal_moves", "get_eval", "get_book_moves"]) {
      assertInvalid(cmd, { fen: 42 }, "fen");
      assertInvalid(cmd, { fen: null }, "fen");
      assertValid(cmd, {});
      assertValid(cmd, { fen: "" });
      assertValid(cmd, { fen: STARTPOS });
    }
  });

  it("rejects non-string books_dir, allows the eval flag through", () => {
    assertInvalid("get_book_moves", { books_dir: 42 }, "books_dir");
    assertValid("get_book_moves", { books_dir: "resources/books" });
    assertValid("get_eval", { fen: STARTPOS, use_mentor_eval: false });
    assertValid("get_eval", { fen: STARTPOS, use_mentor_eval: "yes" });
  });
});

describe("navigate_to_move", () => {
  it("rejects missing/non-integer index", () => {
    assertInvalid("navigate_to_move", {}, "index");
    assertInvalid("navigate_to_move", { index: "3" }, "index");
    assertInvalid("navigate_to_move", { index: 2.5 }, "index");
    assertInvalid("navigate_to_move", { index: NaN }, "index");
  });

  it("passes ints including the -1 startpos sentinel", () => {
    assertValid("navigate_to_move", { index: 0 });
    assertValid("navigate_to_move", { index: -1 });
    assertValid("navigate_to_move", { index: 41 });
  });
});

describe("get_engine_move / get_bot_move", () => {
  it("rejects NaN time_limit, negative threads, infinite hash, garbage strength", () => {
    assertInvalid("get_engine_move", { time_limit: NaN }, "time_limit");
    assertInvalid("get_engine_move", { time_limit: 0 }, "time_limit");
    assertInvalid("get_engine_move", { fen: STARTPOS, threads: -4 }, "threads");
    assertInvalid(
      "get_engine_move",
      { fen: STARTPOS, hash_mb: Number.POSITIVE_INFINITY },
      "hash_mb",
    );
    assertInvalid("get_bot_move", { strength: "strong" }, "strength");
    assertInvalid("get_bot_move", { strength: 7.5 }, "strength");
  });

  it("passes the real renderer getEngineMove shape", () => {
    assertValid("get_engine_move", {
      fen: STARTPOS,
      engine_type: "stockfish",
      depth: 11,
      strength: 7,
      stockfish_path: "stockfish",
      threads: 8,
      hash_mb: 512,
      maia3_model: "maia3-5m",
      maia3_device: "cpu",
      maia3_elo: 1500,
      think_profile: "human_like",
      time_remaining: 600,
      time_increment: 5,
    });
  });

  it("passes minimal shapes (backend defaults apply)", () => {
    assertValid("get_engine_move", {});
    assertValid("get_engine_move", { fen: STARTPOS });
    assertValid("get_bot_move", { fen: STARTPOS, strength: 5 });
  });
});

describe("import_pgn", () => {
  it("rejects missing/empty/non-string pgn", () => {
    assertInvalid("import_pgn", {}, "pgn");
    assertInvalid("import_pgn", { pgn: "" }, "pgn");
    assertInvalid("import_pgn", { pgn: 42 }, "pgn");
  });

  it("passes real PGN (backend owns PGN truth)", () => {
    assertValid("import_pgn", { pgn: "1. e4 e5 2. Nf3 *" });
  });
});

describe("calculate_accuracy", () => {
  it("rejects missing lists; empty aligned lists pass (backend owns empty)", () => {
    assertInvalid("calculate_accuracy", {}, "fen_list");
    assertInvalid("calculate_accuracy", { fen_list: [STARTPOS] }, "moves");
    assertValid("calculate_accuracy", { fen_list: [], moves: [] });
  });

  it("rejects element and length garbage", () => {
    assertInvalid(
      "calculate_accuracy",
      { fen_list: [STARTPOS], moves: [42] },
      "moves",
    );
    assertInvalid(
      "calculate_accuracy",
      { fen_list: [STARTPOS, STARTPOS], moves: ["e2e4"] },
      "moves",
    );
    assertInvalid(
      "calculate_accuracy",
      { fen_list: "not-an-array", moves: [] },
      "fen_list",
    );
  });

  it("passes aligned string lists", () => {
    assertValid("calculate_accuracy", {
      fen_list: [STARTPOS],
      moves: ["e2e4"],
    });
  });
});

describe("calculate_accuracy_from_history / from_pgn", () => {
  it("rejects non-string stockfish_path and pgn", () => {
    assertInvalid(
      "calculate_accuracy_from_history",
      { stockfish_path: 42 },
      "stockfish_path",
    );
    assertInvalid("calculate_accuracy_from_pgn", { pgn: 42 }, "pgn");
  });

  it("passes absent/empty shapes (backend owns PGN truth)", () => {
    assertValid("calculate_accuracy_from_history", {});
    assertValid("calculate_accuracy_from_history", {
      stockfish_path: "/usr/bin/stockfish",
    });
    assertValid("calculate_accuracy_from_pgn", {});
    assertValid("calculate_accuracy_from_pgn", { pgn: "" });
    assertValid("calculate_accuracy_from_pgn", {
      pgn: "1. e4 e5 *",
      stockfish_path: "",
    });
  });
});

describe("export_pdf_report (P4-T02)", () => {
  it("rejects non-string game/display fields", () => {
    assertInvalid("export_pdf_report", { pgn: 42 }, "pgn");
    assertInvalid(
      "export_pdf_report",
      { stockfish_path: 42 },
      "stockfish_path",
    );
    assertInvalid("export_pdf_report", { output_path: 42 }, "output_path");
    assertInvalid("export_pdf_report", { white: 42 }, "white");
  });

  it("passes absent/empty shapes (backend owns PGN truth)", () => {
    assertValid("export_pdf_report", {});
    assertValid("export_pdf_report", { stockfish_path: "/usr/bin/stockfish" });
    assertValid("export_pdf_report", {
      pgn: "1. e4 e5 *",
      white: "Scholar",
      black: "Opponent",
      result: "1-0",
    });
  });
});

describe("estimate_elo", () => {
  it("rejects missing/NaN/out-of-range numerics", () => {
    assertInvalid("estimate_elo", {}, "accuracy");
    assertInvalid("estimate_elo", { accuracy: NaN }, "accuracy");
    assertInvalid("estimate_elo", { accuracy: 150 }, "accuracy");
    assertInvalid(
      "estimate_elo",
      { accuracy: 82, blunder_rate: 1.5 },
      "blunder_rate",
    );
    assertInvalid(
      "estimate_elo",
      { accuracy: 82, avg_cp_loss: -3 },
      "avg_cp_loss",
    );
    assertInvalid(
      "estimate_elo",
      { accuracy: 82, num_games: 2.5 },
      "num_games",
    );
    assertInvalid("estimate_elo", { accuracy: "high" }, "accuracy");
  });

  it("passes both real renderer caller shapes", () => {
    assertValid("estimate_elo", {
      accuracy: 82.4,
      blunder_rate: 0.05,
      avg_cp_loss: 18.2,
    });
    assertValid("estimate_elo", {
      accuracy: 71.0,
      blunder_rate: 0.1,
      avg_cp_loss: 25.5,
      num_games: 4,
    });
  });
});

describe("start_analysis", () => {
  it("rejects missing/empty callback_id and bad multipv", () => {
    assertInvalid("start_analysis", {}, "callback_id");
    assertInvalid(
      "start_analysis",
      { callback_id: "", multipv: 1 },
      "callback_id",
    );
    assertInvalid(
      "start_analysis",
      { callback_id: "cb", multipv: 0 },
      "multipv",
    );
    assertInvalid(
      "start_analysis",
      { callback_id: "cb", multipv: 1.5 },
      "multipv",
    );
    assertInvalid(
      "start_analysis",
      { callback_id: "cb", threads: -2 },
      "threads",
    );
  });

  it("passes the real renderer shape", () => {
    assertValid("start_analysis", {
      fen: STARTPOS,
      multipv: 1,
      callback_id: "play-analysis",
      stockfish_path: "stockfish",
      threads: 8,
      hash_mb: 512,
    });
  });
});

describe("maia3-cache / check-maia3-cache", () => {
  it("rejects non-string model", () => {
    assertInvalid("maia3_cache", { model: 42 }, "model");
    assertInvalid("maia3_cache", { model: "" }, "model");
    assertInvalid("check_maia3_cache", { model: 42 }, "model");
    // Hyphenated IPC channel spellings (what main.ts actually validates).
    assertInvalid("maia3-cache", { model: 42 }, "model");
    assertInvalid("check-maia3-cache", { model: 42 }, "model");
  });

  it("passes absent/optional shapes (backend defaults apply)", () => {
    assertValid("maia3_cache", {});
    assertValid("check_maia3_cache", {});
    assertValid("check_maia3_cache", { model: "maia3-23m" });
    assertValid("maia3_cache", {
      model: "maia3-5m",
      cache_dir: "/tmp/maia",
      force_download: false,
    });
  });
});

describe("new_game", () => {
  it("rejects non-object and garbage numerics", () => {
    assertInvalid("new_game", null, "params");
    assertInvalid("new_game", { threads: "lots" }, "threads");
    assertInvalid("new_game", { strength: NaN }, "strength");
    assertInvalid("new_game", { hash_mb: -512 }, "hash_mb");
    assertInvalid(
      "new_game",
      { time_control: { seconds: -60 } },
      "time_control",
    );
  });

  it("passes the real renderer newGame payload", () => {
    assertValid("new_game", {
      mode: "human_vs_ai",
      engine_type: "stockfish",
      human_color: "white",
      strength: 7,
      stockfish_path: "stockfish",
      maia3_path: "",
      maia3_model: "maia3-5m",
      maia3_device: "cpu",
      maia3_elo: 1500,
      think_profile: "human_like",
      threads: 8,
      hash_mb: 512,
      multipv: 1,
      time_control: { seconds: 600, increment: 5, label: "10+5" },
    });
  });

  it("passes empty params (backend defaults apply)", () => {
    assertValid("new_game", {});
  });
});
