import React, { useCallback, useEffect, useRef, useState } from 'react';

const SQ_SIZE = 56;

const DRAW_COLORS = [
  { stroke: '#22C55E', fill: 'rgba(34,197,94,0.45)', label: 'green' },
  { stroke: '#EF4444', fill: 'rgba(239,68,68,0.45)', label: 'red' },
  { stroke: '#3B82F6', fill: 'rgba(59,130,246,0.45)', label: 'blue' },
  { stroke: '#FACC15', fill: 'rgba(250,204,21,0.45)', label: 'yellow' },
  { stroke: '#A855F7', fill: 'rgba(168,85,247,0.45)', label: 'purple' },
  { stroke: '#F97316', fill: 'rgba(249,115,22,0.45)', label: 'orange' },
];

export interface Arrow {
  from: string;
  to: string;
  colorIdx: number;
}

export interface SquareMark {
  sq: string;
  colorIdx: number;
}

interface Props {
  flipped: boolean;
  arrows?: Arrow[];
  showArrowsFromAnalysis?: boolean;
  analysisPV?: string[];
  analysisAltPVs?: string[][];
  showThreatPV?: string[];
  onArrowsChange?: (arrows: Arrow[]) => void;
  onMarksChange?: (marks: SquareMark[]) => void;
}

function getBoardRect(svgEl: SVGSVGElement | null) {
  const boardEl = svgEl?.parentElement;
  return boardEl?.getBoundingClientRect();
}

function squareFromRect(clientX: number, clientY: number, rect: DOMRect, flipped: boolean): string | null {
  const size = rect.width / 8;
  const bx = clientX - rect.left;
  const by = clientY - rect.top;
  if (bx < 0 || by < 0 || bx >= rect.width || by >= rect.height) return null;
  let file = Math.floor(bx / size);
  let rank = 7 - Math.floor(by / size);
  if (flipped) { file = 7 - file; rank = 7 - rank; }
  return String.fromCharCode(97 + file) + (rank + 1);
}

function getColorFromMods(e: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }) {
  if (e.shiftKey) return 3;
  if (e.ctrlKey || e.metaKey) return 1;
  if (e.altKey) return 2;
  return 0;
}

export const BoardDrawingLayer: React.FC<Props> = ({
  flipped,
  arrows = [],
  showArrowsFromAnalysis = false,
  analysisPV = [],
  analysisAltPVs = [],
  showThreatPV = [],
  onArrowsChange,
  onMarksChange,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // State (triggers re-render / canvas redraw)
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<string | null>(null);
  const [previewEnd, setPreviewEnd] = useState<string | null>(null);
  const [userArrows, setUserArrows] = useState<Arrow[]>(arrows);
  const [squareMarks, setSquareMarks] = useState<SquareMark[]>([]);
  const [drawColorIdx, setDrawColorIdx] = useState(0);

  // Refs (mutable — always current, for mount-once window listeners)
  const flippedRef = useRef(flipped);
  flippedRef.current = flipped;
  const drawingRef = useRef(false);
  const drawStartRef = useRef<string | null>(null);
  const drawButtonRef = useRef<'left' | 'right' | null>(null);
  const drawColorIdxRef = useRef(0);
  const userArrowsRef = useRef<Arrow[]>(arrows);
  userArrowsRef.current = userArrows;
  const onArrowsChangeRef = useRef(onArrowsChange);
  onArrowsChangeRef.current = onArrowsChange;
  const onMarksChangeRef = useRef(onMarksChange);
  onMarksChangeRef.current = onMarksChange;
  const ctrlHeldRef = useRef(false);
  const shiftHeldRef = useRef(false);
  const altHeldRef = useRef(false);

  // Sync user arrows from parent
  useEffect(() => { setUserArrows(arrows); }, [arrows]);

  const syncPointerEvents = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const capture = drawingRef.current || ctrlHeldRef.current || shiftHeldRef.current || altHeldRef.current;
    svg.style.pointerEvents = capture ? 'all' : 'none';
  }, []);

  const getSquareFromClient = useCallback((clientX: number, clientY: number): string | null => {
    const rect = getBoardRect(svgRef.current);
    if (!rect) return null;
    return squareFromRect(clientX, clientY, rect, flippedRef.current);
  }, []);

  const getSquareFromEvent = useCallback((e: React.MouseEvent): string | null => {
    return getSquareFromClient(e.clientX, e.clientY);
  }, [getSquareFromClient]);

  // ── Left-click (React synthetic events on SVG — always fresh) ──
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!e.ctrlKey && !e.shiftKey) return;
    const sq = getSquareFromEvent(e);
    if (!sq) return;
    const colorIdx = getColorFromMods(e);
    if (e.shiftKey && !e.ctrlKey) {
      setSquareMarks((prev) => {
        const existing = prev.findIndex((m) => m.sq === sq);
        const updated = existing >= 0
          ? prev.filter((_, i) => i !== existing)
          : [...prev, { sq, colorIdx }];
        onMarksChangeRef.current?.(updated);
        return updated;
      });
      return;
    }
    drawingRef.current = true;
    drawStartRef.current = sq;
    drawButtonRef.current = 'left';
    drawColorIdxRef.current = colorIdx;
    syncPointerEvents();
    setIsDrawing(true);
    setDrawStart(sq);
    setPreviewEnd(sq);
    setDrawColorIdx(colorIdx);
  }, [getSquareFromEvent, syncPointerEvents]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDrawing) return;
    const sq = getSquareFromEvent(e);
    if (sq && sq !== previewEnd) setPreviewEnd(sq);
  }, [isDrawing, getSquareFromEvent, previewEnd]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!isDrawing) return;
    const endSq = getSquareFromEvent(e);
    setIsDrawing(false);
    drawingRef.current = false;
    drawButtonRef.current = null;
    syncPointerEvents();
    if (!endSq || !drawStart) { setDrawStart(null); setPreviewEnd(null); drawStartRef.current = null; return; }
    if (endSq === drawStart) { setDrawStart(null); setPreviewEnd(null); drawStartRef.current = null; return; }
    const existing = userArrows.findIndex(
      (a) => a.from === drawStart && a.to === endSq,
    );
    const updated = existing >= 0
      ? userArrows.filter((_, i) => i !== existing)
      : [...userArrows, { from: drawStart, to: endSq, colorIdx: drawColorIdx }];
    setUserArrows(updated);
    userArrowsRef.current = updated;
    onArrowsChangeRef.current?.(updated);
    setDrawStart(null);
    drawStartRef.current = null;
    setPreviewEnd(null);
  }, [isDrawing, getSquareFromEvent, drawStart, userArrows, drawColorIdx, syncPointerEvents]);

  const handleMouseLeave = useCallback(() => {
    if (isDrawing) {
      setIsDrawing(false);
      drawingRef.current = false;
      drawButtonRef.current = null;
      syncPointerEvents();
      setDrawStart(null);
      drawStartRef.current = null;
      setPreviewEnd(null);
    }
  }, [isDrawing, syncPointerEvents]);

  // ── Right-click (window listeners — mount once, read refs) ──
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const rect = getBoardRect(svgRef.current);
      if (rect && squareFromRect(e.clientX, e.clientY, rect, flippedRef.current)) {
        e.preventDefault();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 2) return;
      const rect = getBoardRect(svgRef.current);
      if (!rect) return;
      const sq = squareFromRect(e.clientX, e.clientY, rect, flippedRef.current);
      if (!sq) return;
      e.preventDefault();
      drawingRef.current = true;
      drawStartRef.current = sq;
      drawButtonRef.current = 'right';
      drawColorIdxRef.current = getColorFromMods(e);
      syncPointerEvents();
      setDrawColorIdx(drawColorIdxRef.current);
      setIsDrawing(true);
      setDrawStart(sq);
      setPreviewEnd(sq);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!drawingRef.current || drawButtonRef.current !== 'right') return;
      const rect = getBoardRect(svgRef.current);
      if (!rect) return;
      const sq = squareFromRect(e.clientX, e.clientY, rect, flippedRef.current);
      if (sq) setPreviewEnd(sq);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!drawingRef.current || drawButtonRef.current !== 'right') return;
      const rect = getBoardRect(svgRef.current);
      if (!rect) return;
      const endSq = squareFromRect(e.clientX, e.clientY, rect, flippedRef.current);
      setIsDrawing(false);
      drawingRef.current = false;
      drawButtonRef.current = null;
      syncPointerEvents();
      const start = drawStartRef.current;
      drawStartRef.current = null;
      if (!endSq || !start) { setDrawStart(null); setPreviewEnd(null); return; }
      if (endSq === start) {
        setSquareMarks((prev) => {
          const existing = prev.findIndex((m) => m.sq === endSq);
          const updated = existing >= 0
            ? prev.filter((_, i) => i !== existing)
            : [...prev, { sq: endSq, colorIdx: drawColorIdxRef.current }];
          onMarksChangeRef.current?.(updated);
          return updated;
        });
        setDrawStart(null);
        setPreviewEnd(null);
        return;
      }
      const existing = userArrowsRef.current.findIndex(
        (a) => a.from === start && a.to === endSq,
      );
      const updated = existing >= 0
        ? userArrowsRef.current.filter((_, i) => i !== existing)
        : [...userArrowsRef.current, { from: start, to: endSq, colorIdx: drawColorIdxRef.current }];
      setUserArrows(updated);
      userArrowsRef.current = updated;
      onArrowsChangeRef.current?.(updated);
      setDrawStart(null);
      setPreviewEnd(null);
    };
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [syncPointerEvents]);

  // ── Keyboard listeners (mount once, read refs) ──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') { shiftHeldRef.current = true; syncPointerEvents(); }
      if (e.key === 'Alt') { altHeldRef.current = true; syncPointerEvents(); }
      if (e.key === 'Control' || e.key === 'Meta') { ctrlHeldRef.current = true; syncPointerEvents(); }
      if (e.key === 'c' || e.key === 'C') {
        if (e.ctrlKey || e.metaKey) {
          setUserArrows([]);
          userArrowsRef.current = [];
          onArrowsChangeRef.current?.([]);
          setSquareMarks([]);
          onMarksChangeRef.current?.([]);
        }
      }
      if (e.key === '1') setDrawColorIdx(0);
      if (e.key === '2') setDrawColorIdx(1);
      if (e.key === '3') setDrawColorIdx(2);
      if (e.key === '4') setDrawColorIdx(3);
      if (e.key === '5') setDrawColorIdx(4);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') { shiftHeldRef.current = false; syncPointerEvents(); }
      if (e.key === 'Alt') { altHeldRef.current = false; syncPointerEvents(); }
      if (e.key === 'Control' || e.key === 'Meta') { ctrlHeldRef.current = false; syncPointerEvents(); }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [syncPointerEvents]);

  // ── Merge user + analysis arrows ──
  const allArrows = React.useMemo(() => {
    const merged: Arrow[] = [...userArrows];
    if (isDrawing && drawStart && previewEnd && previewEnd !== drawStart) {
      merged.push({ from: drawStart, to: previewEnd, colorIdx: drawColorIdx });
    }

    if (showArrowsFromAnalysis && analysisPV.length >= 1) {
      const bestMove = analysisPV[0];
      if (bestMove.length >= 4) {
        const from = bestMove.slice(0, 2);
        const to = bestMove.slice(2, 4);
        if (!merged.some((a) => a.from === from && a.to === to)) {
          merged.push({ from, to, colorIdx: 3 });
        }
      }
    }

    if (showArrowsFromAnalysis && showThreatPV.length >= 1) {
      const threatMove = showThreatPV[0];
      if (threatMove.length >= 4) {
        const from = threatMove.slice(0, 2);
        const to = threatMove.slice(2, 4);
        if (!merged.some((a) => a.from === from && a.to === to)) {
          merged.push({ from, to, colorIdx: 1 });
        }
      }
    }

    if (showArrowsFromAnalysis) {
      analysisAltPVs.forEach((pv, pi) => {
        if (pv.length >= 1) {
          const altMove = pv[0];
          if (altMove.length >= 4) {
            const from = altMove.slice(0, 2);
            const to = altMove.slice(2, 4);
            if (!merged.some((a) => a.from === from && a.to === to)) {
              merged.push({ from, to, colorIdx: Math.min(pi + 2, DRAW_COLORS.length - 1) });
            }
          }
        }
      });
    }

    return merged;
  }, [userArrows, isDrawing, drawStart, previewEnd, drawColorIdx, showArrowsFromAnalysis, analysisPV, showThreatPV, analysisAltPVs]);

  // ── Canvas drawing ──
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !svgRef.current) return;
    const boardRect = getBoardRect(svgRef.current);
    if (!boardRect) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = boardRect.width * dpr;
    canvas.height = boardRect.height * dpr;
    canvas.style.width = `${boardRect.width}px`;
    canvas.style.height = `${boardRect.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, boardRect.width, boardRect.height);

    const sq = boardRect.width / 8;
    const f = flippedRef.current;
    const toPoint = (sqName: string) => {
      const file = sqName.charCodeAt(0) - 97;
      const rank = parseInt(sqName[1]) - 1;
      const fx = f ? 7 - file : file;
      const fy = f ? rank : 7 - rank;
      return { x: (fx + 0.5) * sq, y: (fy + 0.5) * sq };
    };

    squareMarks.forEach((mark) => {
      const c = DRAW_COLORS[mark.colorIdx] ?? DRAW_COLORS[0];
      const { x, y } = toPoint(mark.sq);
      const radius = sq * 0.38;
      ctx.save();
      ctx.strokeStyle = c.stroke;
      ctx.fillStyle = c.fill;
      ctx.lineWidth = Math.max(2.5, sq * 0.08);
      ctx.shadowColor = c.stroke;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });

    allArrows.forEach((arrow) => {
      const c = DRAW_COLORS[arrow.colorIdx] ?? DRAW_COLORS[0];
      const { x: x1, y: y1 } = toPoint(arrow.from);
      const { x: x2, y: y2 } = toPoint(arrow.to);
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 8) return;
      const angle = Math.atan2(dy, dx);
      const base = sq * 0.2;
      const headLen = Math.max(18, Math.min(26, len * 0.26));
      const shaftWidth = Math.max(8, Math.min(12, len * 0.07));
      const headWidth = Math.max(16, Math.min(28, len * 0.18));
      const shaftLen = Math.max(8, len - headLen - base);

      ctx.save();
      ctx.translate(x1, y1);
      ctx.rotate(angle);
      ctx.fillStyle = c.fill;
      ctx.strokeStyle = c.stroke;
      ctx.lineWidth = 2;
      ctx.shadowColor = c.stroke;
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.moveTo(base, -shaftWidth / 2);
      ctx.lineTo(base + shaftLen, -shaftWidth / 2);
      ctx.lineTo(base + shaftLen, -headWidth / 2);
      ctx.lineTo(len, 0);
      ctx.lineTo(base + shaftLen, headWidth / 2);
      ctx.lineTo(base + shaftLen, shaftWidth / 2);
      ctx.lineTo(base, shaftWidth / 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });
  }, [allArrows, squareMarks]);

  useEffect(() => {
    drawCanvas();
    const onResize = () => drawCanvas();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [drawCanvas]);

  useEffect(() => {
    if (!svgRef.current) return;
    syncPointerEvents();
  });

  return (
    <svg
      ref={svgRef}
      width="100%"
      height="100%"
      viewBox={`0 0 ${8 * SQ_SIZE} ${8 * SQ_SIZE}`}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'visible',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    >
      <foreignObject x={0} y={0} width={8 * SQ_SIZE} height={8 * SQ_SIZE}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', pointerEvents: 'none', display: 'block' }}
        />
      </foreignObject>
    </svg>
  );
};

export function getSquareFromBoardCoord(
  clientX: number,
  clientY: number,
  boardEl: HTMLElement,
  flipped: boolean,
): string | null {
  const rect = boardEl.getBoundingClientRect();
  return squareFromRect(clientX, clientY, rect, flipped);
}
