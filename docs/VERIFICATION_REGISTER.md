# Verification Register — companion to `REMEDIATION_PLAN.md`

**Read before `REMEDIATION_PLAN.md`. Authoritative wherever the two disagree.**

Scope: only the discrepancies found while checking the plan's anchors. The do-not-implement
list is already in the plan's Appendix B and is **not** repeated here.

State of the plan: 73 anchors, all resolve in-bounds. ~66 point at the claimed construct.
4 are **drifted** (correct line below). 1 was a false alarm in my own check. 3 claims have a
**wrong premise** — worse than a bad line, because the description does not match the code.

---

## 1. Corrected anchors

| Plan says                   | Actual                      | Note                                                                                                                                                                                                    |
| --------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mentor_engine.py:1065`     | **`:1068`** and **`:1078`** | `:1065` is popcount (`bb &= bb - u1`). Defect is `eg_score += val + pst_king_end[sq]` at `:1068`, mirror at `:1078`. Kings are **correct** at `:1082`/`:1086` — leave those. Defect real; anchor wrong. |
| `vite.config.ts:6`          | **`:9`**                    | `:6` is `root: 'renderer'`. Alias is at `:9`. P0-T02's intent holds.                                                                                                                                    |
| `PlayView.tsx:73` and `:86` | **`:75`** and **`:88`**     | Both `ResizeObserver`. See §2b.                                                                                                                                                                         |
| `service.py:246-250`        | **`:389-391`**              | See §2a.                                                                                                                                                                                                |

**Retracted — my error:** `electron-builder.yml:9-13` is **correct**. The
`node_modules/**/*` glob is at `:12`, inside the range. My check sampled only the first two
lines and flagged it wrongly.

---

## 2. Wrong premise — re-scope before implementing

### 2a. P2-T19 `num_games` — the cited mechanism does not exist

Plan: _"`num_games` is an unclamped loop bound taken from IPC input"_, cited `:246-250`.
That range is HF-hub alias code. The real location (`:389-391`) is:

```
num_games = params.get("num_games")
if num_games is not None:
    num_games = int(num_games)
```

It is passed to `estimate_elo(num_games=...)` as a **statistical weight**, not a loop bound.
Two possibilities, and the item cannot be scoped without checking which:

- `int()` with no range check still deserves a clamp (a huge or negative value skews a
  weighted mean) — but that is a different defect, different line, different justification.
- The "loop bound" claim is simply wrong and there is nothing to fix.

Do not implement a clamp against the plan's wording. **No DoS framing** — the value reaches
a local analysis function, not a request-parsing path.

**Correction — the above is wrong (re-verified 2026-09-28 by direct read).**
`estimate_elo` (`backend/analysis.py:246-250`) does `estimated_games = num_games`,
then `for _ in range(estimated_games): rating.update_single(...)`. `num_games`
**is** an IPC-fed loop bound, so the plan's wording stands and the "no DoS framing"
instruction is withdrawn: a huge value is a CPU-DoS vector in the IPC handler thread.
Negatives/zero are already neutralized by the `>= 1` guard; non-numeric input raises
unhandled `ValueError` at `service.py:391`. P2-T19 implements the clamp per the plan,
at the corrected line (`service.py:389-391`).

### 2b. P0-T03 `matchMedia` — nothing calls it

Plan: jsdom lacks `matchMedia` **and** `ResizeObserver` in `PlayView.tsx`. `PlayView.tsx`
uses `ResizeObserver` at `:75` and `:88` and `matchMedia` **zero times**. Confirm the real
consumer before writing the stub; otherwise stub `ResizeObserver` only. An unused stub is
harmless but signals the plan was not read.

**Accepted 2026-09-28:** zero `matchMedia` hits renderer-wide (verified, `rg` exit 1).
P0-T03 stubs `ResizeObserver` only.

### 2c. P4-T03 `cpp_engine` does not compile on gcc — the plan's build claim is wrong

The plan states the non-Windows branch (`-O3 -std=c++17 -march=native`) exists, so
`setup.py build_ext --inplace` "should work today," and the toolchain was reported present.
**The toolchain is present; the code does not build.** `cpp_engine/evaluate.h:23` uses
`__popcnt64` and `:27` uses `_BitScanForward64` — both MSVC-only, **unguarded**. gcc needs
`__builtin_popcountll` and `__builtin_ctzll`. This was never tested; the claim was inferred
from `setup.py` having a non-Windows branch.

**Consequence:** the plan's P4-T03 "Tier 3 — compiled kernel" cannot run on the Linux CI
runner until these are shimmed. Add a guarded portability layer (`#if defined(_MSC_VER)` /
`__builtin_*`) and treat "builds clean on gcc -Wall -Wextra" as its own done-when, separate
from the evaluation-correctness work.

**Accepted 2026-09-28 (direct read of `cpp_engine/evaluate.h:22-29`; zero
`_MSC_VER`/`__GNUC__`/`__builtin_` hits in `cpp_engine/`): hard precondition on
P4-T03. Tier 3 does not start until the shim exists and the extension builds clean
on `gcc -Wall -Wextra`. Tiers 1-2 ship independently if Tier 3 cannot build.

---

## 3. Location confirmed, defect NOT yet proven

Anchor points at the right function; the defect is a claim _about_ code inside it. These are
the plan's weakest links.

| Item                                         | Anchor                          | Confirmed                                          | Not yet proven                                                   |
| -------------------------------------------- | ------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| P2-T10 Maia3 ignores budget                  | `bots/maia3_bot.py:55-85`       | `def play` at `:55`                                | that it never reads `request.time_limit_sec`                     |
| P2-T12 mg == eg                              | `chess_engine.py:671-703`       | `_get_mg_score` at `:671`                          | that the two bodies are byte-identical                           |
| P2-T19 score overwrites while `is_mate` true | `bots/base.py:272-275`          | `normalize_score(...)` at `:272`                   | that `mate_in` is not cleared                                    |
| P2-T17 canvas not redrawn on flip            | `BoardDrawingLayer.tsx:366-372` | `toPoint` at `:366`                                | `flipped` absent from dep arrays (`:366-372`, `:427-434`)        |
| P2-T19 `MoveHistory` black button            | `MoveHistory.tsx:100`           | `onClick={() => black && onMoveClick?.(blackIdx)}` | that it renders in that state at all                             |
| P3-T02 defaults are a strict subset          | `settings.defaults.json:1-26`   | file exists, 26 lines                              | that it omits every key named — needs a key-by-key diff          |
| P3-T02 duplicate defaults                    | `main.ts:87-132`                | `getDefaultsPath()` at `:87`                       | that it restates the whole default set                           |
| P3-T01 clock never debited                   | `chess_engine.py:527-533`       | `time_remaining` read at `:527`                    | that no clock is decremented anywhere — needs a repo-wide search |

**Confirmed by direct read — do not re-verify:** P1-T01 (book path + duplicate
`applyMoveResult`); P1-T02 (process-wide stdout capture); P1-T03 (history truncation);
P1-T04 (absent `_uci_lock`); the Glicko-2 constant-`1500`; the three P4-T01 Syzygy defects;
the P4-T03 `return 0` on parse failure; the toolchain inventory.

---

## 4. Fill in before writing code

| Item            | Status             | Anchor drift | Defect proven | Correct line / note |
| --------------- | ------------------ | ------------ | ------------- | ------------------- |
| P0-T01 … P0-T14 |                    |              |               |                     |
| P1-T01 … P1-T04 | CONFIRMED (see §3) | —            | yes           |                     |
| P2-T01 … P2-T20 |                    |              |               |                     |
| P3-T01 … P3-T07 |                    |              |               |                     |
| P4-T01 … P4-T05 |                    |              |               |                     |

**Vocabulary, use exactly:** `CONFIRMED` · `ANCHOR-DRIFTED` (defect real, line wrong →
record it) · `CONTRADICTED` (code does not behave as described → **stop and report**) ·
`ALREADY-HANDLED` (still add and commit the test) · `FALSE-POSITIVE` (move to Appendix B
with your evidence).

**Rules**

1. The **description** is authoritative; the **line number** is a hint. Drifted anchor →
   re-locate, do not void the item.
2. `CONTRADICTED` blocks the item. Never edit code to match the plan.
3. A sub-agent's report is not verification. Spot-check at least one claim per item
   yourself before committing.
4. If a claim here turns out wrong, correct **this** file in the same commit as the fix.
   The register is maintained, not written once.

---

## 5. Phase A adjudication (2026-09-28)

Standing rule: **this register outranks the plan wherever they disagree.**

- §2a **reversed** — see correction inline. Plan's `num_games` wording stands.
- §2b **accepted** — P0-T03 stubs `ResizeObserver` only.
- §2c **accepted** — hard precondition on P4-T03 (see inline).
- P2-T19 excludes the `_phase (:1220) unused` sub-point — `mentor._phase` is called
  at `backend/chess_engine.py:664`. Remainder of P2-T19 stands, with nuances:
  `normalize_score` residue is `is_mate=True / mate_in=None / eval_cp=numeric`
  (fix the flag, not `mate_in` — it is already cleared); `MoveHistory` black button
  renders but no-ops (fix is a11y hygiene, not a phantom-click bug).
- P3-T02 "five definitions" is at most **four** — `electron/main.ts:87-132` reads
  and normalizes the JSON file, it does not restate defaults. No `main.ts` change
  in P3-T02; the four sources, missing version, contradicting limits, and
  unchecked `loadFromBackend` remain in scope.
- Item-level verdicts conceal sub-point issues (framing note, accepted) — Phase B
  reports carry sub-point verdicts.
