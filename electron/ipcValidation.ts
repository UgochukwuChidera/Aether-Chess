/**
 * IPC payload validation for P3-T03.
 *
 * Every chess-command payload used to reach the backend unchecked, so a
 * malformed `maia3_model`, `fen`, or numeric reached `backend/service.py`
 * and failed there (KeyError/ValueError/TypeError) or was silently coerced.
 * These validators run at the `ipcMain.handle` boundary in `main.ts`: on
 * failure the handler throws, so `invoke()` rejects with a field-naming
 * error; on success the params forward byte-identically.
 *
 * Proportionality (explicit item note — no codegen pipeline, no chess
 * semantics): SHAPE + PRESENCE + PRIMITIVE sanity only. Required string
 * fields must be present/non-empty; numeric fields must be finite numbers
 * within sane bounds where the backend would crash or loop (negative
 * threads, NaN/Infinity, unbounded loop-style numerics); unknown/extra keys
 * are IGNORED, never rejected (forward-compat). There is deliberately no
 * FEN/UCI validation here — the backend owns chess truth and already raises
 * `Illegal move`; an empty-string `fen` keeps its current meaning (fall back
 * to the live board) rather than becoming an error.
 *
 * Zero Electron (and zero Node-API) dependencies, the same shape as
 * `shellPolicy.ts`: `main.ts` imports `electron` and throws under plain
 * Node (P0-T09 precedent), so this module must stay unit-testable in
 * isolation under `node --test`.
 *
 * Per-command rule table (rule → crash it prevents; every rule was read
 * against the backend handler's first use of the field):
 *
 * | command (+rule source)            | rule                                             | prevents                                    |
 * | --------------------------------- | ------------------------------------------------ | ------------------------------------------- |
 * | make_move (`str(params["move"])`) | `move`: required non-empty string                | backend KeyError on missing                 |
 * | resign (`resign(side)`)           | `side`: required, `white`\|`black`               | backend "Invalid resign side" round-trip    |
 * | navigate_to_move (`int(...)`)     | `index`: required finite integer                 | KeyError/ValueError; float truncation       |
 * | get_engine_move (`float(...)`)    | `time_limit`: finite number > 0 if present      | ValueError; zero-budget search              |
 * | get_engine_move/get_bot_move      | `depth`: integer >= 1 if present                 | invalid `go depth`                          |
 * | get_bot_move/new_game (`int()`)   | `strength`: finite integer if present            | ValueError on garbage                       |
 * | *-engine/*-analysis/new_game      | `threads`: finite number in [1, 1024] if present | negative/absurd resource claim             |
 * | *-engine/*-analysis/new_game      | `hash_mb`: finite number in [1, 65536] if present| negative/absurd resource claim             |
 * | start_analysis/new_game           | `multipv`: finite integer >= 1 if present        | ValueError; MultiPV 0                      |
 * | start_analysis (`params[...]`)    | `callback_id`: required non-empty string         | KeyError + unroutable analysis stream       |
 * | *_moves/get_eval (`params.get`)   | `fen`: string if present (empty = board fallback)| TypeError in `chess.Board(non_string)`      |
 * | import_pgn (`str(params["pgn"])`) | `pgn`: required non-empty string                 | backend KeyError on missing                 |
 * | calculate_accuracy (`params[..]`) | `fen_list`/`moves`: required string arrays,      | KeyError; backend ValueError on length      |
 * |                                   | same length (empty aligned = backend's call)     | mismatch                                    |
 * | *_history/*_pgn (`.get`)         | `pgn`/`stockfish_path`: strings if present      | TypeError; `""` keeps auto-detect meaning  |
 * | estimate_elo (`float(...)`)      | `accuracy`: required finite 0–100; `blunder_     | ValueError; nonsense Elo math              |
 * |                                   | rate` 0–1, `avg_cp_loss` >= 0, `num_games`       | (`num_games` magnitude clamped by backend)  |
 * |                                   | finite integer, all only if present              |                                             |
 * | maia3-cache (`params.get`)       | `model`: non-empty string if present;            | garbage `--model` arg to the cache script   |
 * |                                   | `cache_dir`/`hf_token`: strings if present      |                                             |
 * | new_game (all `.get`/clamped)    | object; per-present-key primitive checks;        | garbage reaching engine config              |
 * |                                   | `time_control` object with finite >= 0           |                                             |
 * |                                   | seconds/increment if present                     |                                             |
 * | draw/undo/list/export/stop       | no rule — params ignored today                   | (nothing to crash)                          |
 *
 * Local (non-backend) handlers already guard their own inputs
 * (`save-game-history`, `load-game-pgn`, `delete-game-history`,
 * `update-game-tags`, `compute-and-cache-elo` presence checks; P2-T06 shell
 * guards; P3-T02 settings normalization) and are out of scope.
 */

// Resource claims beyond physical sense. The backend clamps threads/hash to
// much smaller policy values (P3-T02); these caps are garbage guards only —
// anything the renderer can legitimately send (<= 64 threads, <= 2048 MB)
// passes untouched.
const MAX_THREADS = 1024;
const MAX_HASH_MB = 65536;

type Params = Record<string, unknown>;

function isObject(value: unknown): value is Params {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** Present-but-undefined counts as absent (missing means "backend default"). */
function checkOptionalString(params: Params, field: string): string | null {
  const value = params[field];
  if (value === undefined) return null;
  if (typeof value !== "string") {
    return `field '${field}' must be a string`;
  }
  return null;
}

function checkOptionalNonEmptyString(
  params: Params,
  field: string,
): string | null {
  const value = params[field];
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    return `field '${field}' must be a non-empty string`;
  }
  return null;
}

function checkRequiredNonEmptyString(
  params: Params,
  field: string,
): string | null {
  const value = params[field];
  if (typeof value !== "string" || value.length === 0) {
    return `field '${field}' is required (non-empty string)`;
  }
  return null;
}

function checkRequiredInteger(params: Params, field: string): string | null {
  if (!isInteger(params[field])) {
    return `field '${field}' is required (finite integer)`;
  }
  return null;
}

function checkOptionalInteger(params: Params, field: string): string | null {
  const value = params[field];
  if (value === undefined) return null;
  if (!isInteger(value)) {
    return `field '${field}' must be a finite integer`;
  }
  return null;
}

function checkThreads(params: Params): string | null {
  const value = params["threads"];
  if (value === undefined) return null;
  if (!isFiniteNumber(value) || value < 1 || value > MAX_THREADS) {
    return `field 'threads' must be a finite number in [1, ${MAX_THREADS}]`;
  }
  return null;
}

function checkHashMb(params: Params): string | null {
  const value = params["hash_mb"];
  if (value === undefined) return null;
  if (!isFiniteNumber(value) || value < 1 || value > MAX_HASH_MB) {
    return `field 'hash_mb' must be a finite number in [1, ${MAX_HASH_MB}]`;
  }
  return null;
}

function checkMultipv(params: Params): string | null {
  const value = params["multipv"];
  if (value === undefined) return null;
  if (!isInteger(value) || value < 1) {
    return `field 'multipv' must be a finite integer >= 1`;
  }
  return null;
}

/** Engine-selector strings shared by the move commands and new_game. */
function checkEngineStrings(params: Params): string | null {
  for (const field of [
    "stockfish_path",
    "engine_type",
    "maia3_path",
    "maia3_device",
    "think_profile",
  ]) {
    const err = checkOptionalString(params, field);
    if (err) return err;
  }
  return null;
}

function checkFen(params: Params): string | null {
  // Empty string keeps its current meaning: fall back to the live board
  // (every `handle_*` treats falsy fen that way), so only the type is
  // checked — never the chess content.
  return checkOptionalString(params, "fen");
}

function checkNewGame(params: Params): string | null {
  for (const field of [
    "mode",
    "engine_type",
    "human_color",
    "stockfish_path",
    "maia3_path",
    "maia3_model",
    "maia3_device",
    "think_profile",
    "fen",
  ]) {
    const err = checkOptionalString(params, field);
    if (err) return err;
  }
  for (const field of ["strength", "maia3_elo"]) {
    const err = checkOptionalInteger(params, field);
    if (err) return err;
  }
  for (const check of [checkThreads, checkHashMb, checkMultipv]) {
    const err = check(params);
    if (err) return err;
  }
  const timeControl = params["time_control"];
  if (timeControl !== undefined) {
    if (!isObject(timeControl)) {
      return `field 'time_control' must be an object`;
    }
    for (const field of ["seconds", "increment"]) {
      const value = timeControl[field];
      if (value !== undefined && (!isFiniteNumber(value) || value < 0)) {
        return `field 'time_control.${field}' must be a finite number >= 0`;
      }
    }
    const labelErr = checkOptionalString(timeControl, "label");
    if (labelErr) return labelErr.replace("'label'", "'time_control.label'");
  }
  return null;
}

function checkEngineMoveParams(params: Params): string | null {
  const fenErr = checkFen(params);
  if (fenErr) return fenErr;
  const timeLimit = params["time_limit"];
  if (
    timeLimit !== undefined &&
    (!isFiniteNumber(timeLimit) || timeLimit <= 0)
  ) {
    return `field 'time_limit' must be a finite number > 0`;
  }
  const depth = params["depth"];
  if (depth !== undefined && (!isInteger(depth) || depth < 1)) {
    return `field 'depth' must be a finite integer >= 1`;
  }
  const strengthErr = checkOptionalInteger(params, "strength");
  if (strengthErr) return strengthErr;
  for (const check of [checkThreads, checkHashMb]) {
    const err = check(params);
    if (err) return err;
  }
  for (const field of ["time_remaining", "time_increment", "total_moves"]) {
    const value = params[field];
    if (value !== undefined && (!isFiniteNumber(value) || value < 0)) {
      return `field '${field}' must be a finite number >= 0`;
    }
  }
  return checkEngineStrings(params);
}

function checkCalculateAccuracy(params: Params): string | null {
  for (const field of ["fen_list", "moves"]) {
    const value = params[field];
    if (!Array.isArray(value)) {
      return `field '${field}' is required (array of strings)`;
    }
  }
  const fenList = params["fen_list"] as unknown[];
  const moves = params["moves"] as unknown[];
  if (!fenList.every((v) => typeof v === "string")) {
    return `field 'fen_list' must contain only strings`;
  }
  if (!moves.every((v) => typeof v === "string")) {
    return `field 'moves' must contain only strings`;
  }
  if (fenList.length !== moves.length) {
    return `field 'moves' must match 'fen_list' in length`;
  }
  return null;
}

function checkEstimateElo(params: Params): string | null {
  const accuracy = params["accuracy"];
  if (!isFiniteNumber(accuracy) || accuracy < 0 || accuracy > 100) {
    return `field 'accuracy' is required (finite number in [0, 100])`;
  }
  const blunderRate = params["blunder_rate"];
  if (
    blunderRate !== undefined &&
    (!isFiniteNumber(blunderRate) || blunderRate < 0 || blunderRate > 1)
  ) {
    return `field 'blunder_rate' must be a finite number in [0, 1]`;
  }
  const avgCpLoss = params["avg_cp_loss"];
  if (
    avgCpLoss !== undefined &&
    (!isFiniteNumber(avgCpLoss) || avgCpLoss < 0)
  ) {
    return `field 'avg_cp_loss' must be a finite number >= 0`;
  }
  // Magnitude is the backend's policy (P2-T19 clamps to 100, < 1 normalizes
  // to the heuristic path); the boundary only rejects non-integers.
  const numGames = params["num_games"];
  if (numGames !== undefined && !isInteger(numGames)) {
    return `field 'num_games' must be a finite integer`;
  }
  return null;
}

function checkStartAnalysis(params: Params): string | null {
  const callbackErr = checkRequiredNonEmptyString(params, "callback_id");
  if (callbackErr) return callbackErr;
  const fenErr = checkFen(params);
  if (fenErr) return fenErr;
  const multipvErr = checkMultipv(params);
  if (multipvErr) return multipvErr;
  for (const check of [checkThreads, checkHashMb]) {
    const err = check(params);
    if (err) return err;
  }
  return checkOptionalString(params, "stockfish_path");
}

function checkMaia3Cache(params: Params): string | null {
  const modelErr = checkOptionalNonEmptyString(params, "model");
  if (modelErr) return modelErr;
  for (const field of ["cache_dir", "hf_token"]) {
    const err = checkOptionalString(params, field);
    if (err) return err;
  }
  // force_download is bool()-coerced by the backend; any type is harmless.
  return null;
}

/**
 * Validate the params for a backend-forwarded IPC command.
 *
 * Returns `null` when the payload may be forwarded, or a human-readable
 * error naming the offending field. Unknown commands and unknown/extra keys
 * pass through (forward-compat). Commands that take no structured input
 * (`draw`, `undo_move`, `list_bots`, `export_pgn`, `export_fen`,
 * `stop_analysis`) accept anything.
 */
export function validateIpcParams(
  command: string,
  params: unknown,
): string | null {
  const detail = validateDetail(command, params);
  return detail === null ? null : `Invalid ${command} params: ${detail}`;
}

function validateDetail(command: string, params: unknown): string | null {
  switch (command) {
    case "new_game":
      if (!isObject(params)) return `params must be an object`;
      return checkNewGame(params);
    case "make_move":
      if (!isObject(params)) return `params must be an object`;
      return checkRequiredNonEmptyString(params, "move");
    case "resign": {
      if (!isObject(params)) return `params must be an object`;
      const side = params["side"];
      if (side !== "white" && side !== "black") {
        return `field 'side' must be 'white' or 'black'`;
      }
      return null;
    }
    case "get_legal_moves":
    case "get_eval":
    case "get_book_moves": {
      if (!isObject(params)) return `params must be an object`;
      const fenErr = checkFen(params);
      if (fenErr) return fenErr;
      if (command === "get_book_moves") {
        return checkOptionalString(params, "books_dir");
      }
      return null;
    }
    case "navigate_to_move":
      if (!isObject(params)) return `params must be an object`;
      return checkRequiredInteger(params, "index");
    case "get_engine_move":
    case "get_bot_move":
      if (!isObject(params)) return `params must be an object`;
      return checkEngineMoveParams(params);
    case "import_pgn":
      if (!isObject(params)) return `params must be an object`;
      return checkRequiredNonEmptyString(params, "pgn");
    case "calculate_accuracy":
      if (!isObject(params)) return `params must be an object`;
      return checkCalculateAccuracy(params);
    case "calculate_accuracy_from_history":
      if (!isObject(params)) return `params must be an object`;
      return checkOptionalString(params, "stockfish_path");
    case "calculate_accuracy_from_pgn": {
      if (!isObject(params)) return `params must be an object`;
      const pgnErr = checkOptionalString(params, "pgn");
      if (pgnErr) return pgnErr;
      return checkOptionalString(params, "stockfish_path");
    }
    case "estimate_elo":
      if (!isObject(params)) return `params must be an object`;
      return checkEstimateElo(params);
    case "start_analysis":
      if (!isObject(params)) return `params must be an object`;
      return checkStartAnalysis(params);
    case "maia3_cache":
    case "check_maia3_cache":
    case "maia3-cache":
    case "check-maia3-cache":
      if (!isObject(params)) return `params must be an object`;
      return checkMaia3Cache(params);
    default:
      return null;
  }
}
