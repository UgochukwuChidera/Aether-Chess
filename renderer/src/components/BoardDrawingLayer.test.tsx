/**
 * BoardDrawingLayer.test.tsx — P2-T17: Canvas overlay not redrawn on flip.
 *
 * Fail-first contract: the redraw effect (`BoardDrawingLayer.tsx:433-438`)
 * depends only on the memoized `drawCanvas` (`:431`, deps
 * `[allArrows, squareMarks]`), whose own inputs (`allArrows` memo `:350`,
 * `squareMarks` state) never change on flip — `flipped` is read only via
 * `flippedRef`. With referentially stable arrow/analysis props, flipping
 * therefore never re-invokes the canvas painter, so arrows/marks stay at
 * their unflipped coordinates. The test below flips the layer and asserts
 * a repaint with flipped geometry, so it FAILS on the pre-fix code (zero
 * paint calls post-flip) and passes after `flipped` joins the dep arrays.
 *
 * Isolation warning (found live: naive version passed pre-fix): the layer's
 * `analysisPV = []`-style defaults allocate a FRESH array every render, and
 * `allArrows` lists those arrays as memo deps — so omitting the analysis
 * props busts the memo on every render and the flip repaints incidentally.
 * Stable module-level constants below close that hole: the ONLY thing that
 * may trigger the post-flip repaint is the `flipped` dep itself. (Same
 * masking exists in production: PlayView/Board hand down fresh `[]`
 * defaults, so the overlay repaints by accident today — the fix converts
 * accidental repaint into guaranteed repaint. See commit body.)
 *
 * jsdom obstacle: `HTMLCanvasElement.prototype.getContext` returns null
 * (no `canvas` npm package — verified absent, NOT installed). The test
 * scopes a `getContext` mock (recording stub ctx) plus a fixed
 * `getBoundingClientRect` (448×448 board) in-test and restores both after.
 * Kept separate from `Board.test.tsx`: that file covers Board coordinate
 * labels with no canvas involvement; this one owns the canvas-mock setup.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { BoardDrawingLayer } from "./BoardDrawingLayer";

const BOARD_PX = 448; // 8 × 56, matches SQ_SIZE
const SQ = BOARD_PX / 8;

/** e2 centre in board-px. Unflipped: file e=4 → x 252, rank 2 → y 364. */
const E2_UNFLIPPED = { x: (4 + 0.5) * SQ, y: (7 - 1 + 0.5) * SQ };
/** e2 centre flipped 180°: x 196, y 84. */
const E2_FLIPPED = { x: (7 - 4 + 0.5) * SQ, y: (1 + 0.5) * SQ };

// Stable identities: with these, NOTHING except `flipped` may repaint.
const STABLE_ARROWS = [{ from: "e2", to: "e4", colorIdx: 0 }];
const STABLE_PV: string[] = [];
const STABLE_ALT_PVS: string[][] = [];
const STABLE_THREAT: string[] = [];

function makeStubCtx() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    shadowColor: "",
    shadowBlur: 0,
  };
}

type StubCtx = ReturnType<typeof makeStubCtx>;

let stubCtx: StubCtx;

function installCanvasMocks() {
  stubCtx = makeStubCtx();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    stubCtx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: BOARD_PX,
    height: BOARD_PX,
    left: 0,
    top: 0,
    right: BOARD_PX,
    bottom: BOARD_PX,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as unknown as DOMRect);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("P2-T17 canvas overlay repaint on flip", () => {
  it("repaints the e2→e4 arrow with flipped coordinates after flip", () => {
    installCanvasMocks();
    const { rerender, unmount } = render(
      <BoardDrawingLayer
        flipped={false}
        arrows={STABLE_ARROWS}
        showArrowsFromAnalysis={false}
        analysisPV={STABLE_PV}
        analysisAltPVs={STABLE_ALT_PVS}
        showThreatPV={STABLE_THREAT}
      />,
    );
    try {
      // Initial paint uses unflipped geometry: arrow tail at e2 (252, 364).
      expect(stubCtx.clearRect).toHaveBeenCalled();
      expect(stubCtx.translate).toHaveBeenCalledTimes(1);
      const first = stubCtx.translate.mock.calls[0];
      expect(first[0]).toBeCloseTo(E2_UNFLIPPED.x);
      expect(first[1]).toBeCloseTo(E2_UNFLIPPED.y);

      stubCtx.translate.mockClear();
      stubCtx.clearRect.mockClear();

      rerender(
        <BoardDrawingLayer
          flipped={true}
          arrows={STABLE_ARROWS}
          showArrowsFromAnalysis={false}
          analysisPV={STABLE_PV}
          analysisAltPVs={STABLE_ALT_PVS}
          showThreatPV={STABLE_THREAT}
        />,
      );

      // Pre-fix this is zero calls: nothing re-invoked the painter on flip.
      expect(stubCtx.translate).toHaveBeenCalled();
      const last =
        stubCtx.translate.mock.calls[stubCtx.translate.mock.calls.length - 1];
      expect(last[0]).toBeCloseTo(E2_FLIPPED.x);
      expect(last[1]).toBeCloseTo(E2_FLIPPED.y);
    } finally {
      unmount();
    }
  });
});
