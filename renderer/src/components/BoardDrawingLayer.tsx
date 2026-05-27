/**
 * BoardDrawingLayer.tsx — SVG overlay for:
 *   1. Ctrl+Mouse drag to draw colored arrows
 *   2. Analysis PV arrows overlaid on the board
 *   3. Custom square highlighting from modifier-key combos
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

const SQ_SIZE = 56;

function algebraicToIndex(sq: string, flipped: boolean): { x: number; y: number } {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1]) - 1;
  const x = flipped ? 7 - file : file;
  const y = flipped ? rank : 7 - rank;
  return { x: x * SQ_SIZE + SQ_SIZE / 2, y: y * SQ_SIZE + SQ_SIZE / 2 };
}

function drawArrowSvg(
  x1: number, y1: number, x2: number, y2: number,
  color: string, fill: string,
): React.ReactElement {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const angle = Math.atan2(dy, dx);
  const len = Math.sqrt(dx * dx + dy * dy);
  const headLen = Math.min(14, len * 0.35);
  const ax1 = x2 - headLen * Math.cos(angle - Math.PI / 6);
  const ay1 = y2 - headLen * Math.sin(angle - Math.PI / 6);
  const ax2 = x2 - headLen * Math.cos(angle + Math.PI / 6);
  const ay2 = y2 - headLen * Math.sin(angle + Math.PI / 6);
  const shaftX1 = x1 + 0.3 * dx;
  const shaftY1 = y1 + 0.3 * dy;
  const shaftX2 = x2 - 0.5 * headLen * Math.cos(angle);
  const shaftY2 = y2 - 0.5 * headLen * Math.sin(angle);
  const perp = Math.PI / 2;
  const sw = 4;
  const px1 = shaftX1 + sw * Math.cos(perp);
  const py1 = shaftY1 + sw * Math.sin(perp);
  const px2 = shaftX1 - sw * Math.cos(perp);
  const py2 = shaftY1 - sw * Math.sin(perp);
  const px3 = shaftX2 - sw * Math.cos(perp);
  const py3 = shaftY2 - sw * Math.sin(perp);
  const px4 = shaftX2 + sw * Math.cos(perp);
  const py4 = shaftY2 + sw * Math.sin(perp);
  const path = `M ${px1},${py1} L ${px4},${py4} L ${ax1},${ay1} L ${x2},${y2} L ${ax2},${ay2} L ${px3},${py3} L ${px2},${py2} Z`;
  return (
    <g>
      <path d={path} fill={fill} stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </g>
  );
}

const DRAW_COLORS = [
  { stroke: '#FCD34D', fill: 'rgba(252,211,77,0.35)', label: 'gold' },
  { stroke: '#F87171', fill: 'rgba(248,113,113,0.35)', label: 'red' },
  { stroke: '#60A5FA', fill: 'rgba(96,165,250,0.35)', label: 'blue' },
  { stroke: '#4ADE80', fill: 'rgba(74,222,128,0.35)', label: 'green' },
  { stroke: '#C084FC', fill: 'rgba(192,132,252,0.35)', label: 'purple' },
  { stroke: '#FB923C', fill: 'rgba(251,146,60,0.35)', label: 'orange' },
];

const HIGHLIGHT_COLORS = [
  'rgba(252,211,77,0.35)',
  'rgba(248,113,113,0.35)',
  'rgba(96,165,250,0.35)',
  'rgba(74,222,128,0.35)',
  'rgba(192,132,252,0.35)',
  'rgba(251,146,60,0.35)',
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
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<string | null>(null);
  const [previewEnd, setPreviewEnd] = useState<string | null>(null);
  const [userArrows, setUserArrows] = useState<Arrow[]>(arrows);
  const [squareMarks, setSquareMarks] = useState<SquareMark[]>([]);
  const [drawColorIdx, setDrawColorIdx] = useState(0);
  const [_shiftHeld, setShiftHeld] = useState(false);
  const [altHeld, setAltHeld] = useState(false);

  useEffect(() => { setUserArrows(arrows); }, [arrows]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(true);
      if (e.key === 'Alt') setAltHeld(true);
      if (e.key === 'c' || e.key === 'C') {
        if (e.ctrlKey || e.metaKey) {
          setUserArrows([]);
          onArrowsChange?.([]);
          setSquareMarks([]);
          onMarksChange?.([]);
        }
      }
      if (e.key === '1') setDrawColorIdx(0);
      if (e.key === '2') setDrawColorIdx(1);
      if (e.key === '3') setDrawColorIdx(2);
      if (e.key === '4') setDrawColorIdx(3);
      if (e.key === '5') setDrawColorIdx(4);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(false);
      if (e.key === 'Alt') setAltHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const getSquareFromEvent = useCallback((e: React.MouseEvent): string | null => {
    if (!svgRef.current) return null;
    const rect = svgRef.current.getBoundingClientRect();
    const size = rect.width / 8;
    const bx = e.clientX - rect.left;
    const by = e.clientY - rect.top;
    if (bx < 0 || by < 0 || bx >= rect.width || by >= rect.height) return null;
    let file = Math.floor(bx / size);
    let rank = 7 - Math.floor(by / size);
    if (flipped) { file = 7 - file; rank = 7 - rank; }
    return String.fromCharCode(97 + file) + (rank + 1);
  }, [flipped]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!e.ctrlKey && !e.shiftKey) return;
    const sq = getSquareFromEvent(e);
    if (!sq) return;
    if (e.shiftKey && !e.ctrlKey) {
      if (altHeld) {
        setSquareMarks((prev) => {
          const filtered = prev.filter((m) => m.sq !== sq);
          const updated = filtered.length === prev.length
            ? [...prev, { sq, colorIdx: drawColorIdx }]
            : filtered;
          onMarksChange?.(updated);
          return updated;
        });
      } else {
        setSquareMarks((prev) => {
          const existing = prev.findIndex((m) => m.sq === sq);
          const updated = existing >= 0
            ? prev.filter((_, i) => i !== existing)
            : [...prev, { sq, colorIdx: drawColorIdx }];
          onMarksChange?.(updated);
          return updated;
        });
      }
      return;
    }
    setIsDrawing(true);
    setDrawStart(sq);
    setPreviewEnd(sq);
  }, [getSquareFromEvent, flipped, drawColorIdx, altHeld, onMarksChange]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDrawing) return;
    const sq = getSquareFromEvent(e);
    if (sq && sq !== previewEnd) setPreviewEnd(sq);
  }, [isDrawing, getSquareFromEvent, previewEnd]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const endSq = getSquareFromEvent(e);
    if (!endSq || !drawStart) { setDrawStart(null); setPreviewEnd(null); return; }
    if (endSq === drawStart) { setDrawStart(null); setPreviewEnd(null); return; }
    const existing = userArrows.findIndex(
      (a) => a.from === drawStart && a.to === endSq,
    );
    const updated = existing >= 0
      ? userArrows.filter((_, i) => i !== existing)
      : [...userArrows, { from: drawStart, to: endSq, colorIdx: drawColorIdx }];
    setUserArrows(updated);
    onArrowsChange?.(updated);
    setDrawStart(null);
    setPreviewEnd(null);
  }, [isDrawing, getSquareFromEvent, drawStart, userArrows, drawColorIdx, onArrowsChange]);

  const handleMouseLeave = useCallback(() => {
    if (isDrawing) {
      setIsDrawing(false);
      setDrawStart(null);
      setPreviewEnd(null);
    }
  }, [isDrawing]);

  const allArrows: Arrow[] = [...userArrows];
  if (isDrawing && drawStart && previewEnd && previewEnd !== drawStart) {
    allArrows.push({ from: drawStart, to: previewEnd, colorIdx: drawColorIdx });
  }

  // Best move PV arrow - from first move's from/to
  if (showArrowsFromAnalysis && analysisPV.length >= 1) {
    const bestMove = analysisPV[0];
    if (bestMove.length >= 4) {
      const from = bestMove.slice(0, 2);
      const to = bestMove.slice(2, 4);
      if (!allArrows.some((a) => a.from === from && a.to === to)) {
        allArrows.push({ from, to, colorIdx: 0 }); // gold = best
      }
    }
  }

  // ThreatPV - shows next move from opponent's perspective
  if (showArrowsFromAnalysis && showThreatPV.length >= 1) {
    const threatMove = showThreatPV[0];
    if (threatMove.length >= 4) {
      const from = threatMove.slice(0, 2);
      const to = threatMove.slice(2, 4);
      if (!allArrows.some((a) => a.from === from && a.to === to)) {
        allArrows.push({ from, to, colorIdx: 1 }); // red = threat
      }
    }
  }

  // Alternative PVs - other good moves considered
  if (showArrowsFromAnalysis) {
    analysisAltPVs.forEach((pv, pi) => {
      if (pv.length >= 1) {
        const altMove = pv[0];
        if (altMove.length >= 4) {
          const from = altMove.slice(0, 2);
          const to = altMove.slice(2, 4);
          if (!allArrows.some((a) => a.from === from && a.to === to)) {
            allArrows.push({ from, to, colorIdx: Math.min(pi + 2, DRAW_COLORS.length - 1) });
          }
        }
      }
    });
  }

  return (
    <svg
      ref={svgRef}
      width="100%"
      height="100%"
      viewBox={`0 0 ${8 * SQ_SIZE} ${8 * SQ_SIZE}`}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: isDrawing ? 'all' : 'none',
        overflow: 'visible',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    >
      {squareMarks.map((mark) => {
        const { x, y } = algebraicToIndex(mark.sq, flipped);
        const color = HIGHLIGHT_COLORS[mark.colorIdx] ?? HIGHLIGHT_COLORS[0];
        return (
          <circle
            key={mark.sq}
            cx={x}
            cy={y}
            r={SQ_SIZE * 0.3}
            fill={color}
            stroke={DRAW_COLORS[mark.colorIdx]?.stroke}
            strokeWidth={1.5}
            opacity={0.8}
          />
        );
      })}
      {allArrows.map((arrow, i) => {
        const { x: x1, y: y1 } = algebraicToIndex(arrow.from, flipped);
        const { x: x2, y: y2 } = algebraicToIndex(arrow.to, flipped);
        const c = DRAW_COLORS[arrow.colorIdx] ?? DRAW_COLORS[0];
        return (
          <g key={`${arrow.from}-${arrow.to}-${i}`} style={{ pointerEvents: 'none' }}>
            {drawArrowSvg(x1, y1, x2, y2, c.stroke, c.fill)}
          </g>
        );
      })}
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
  const size = rect.width / 8;
  const bx = clientX - rect.left;
  const by = clientY - rect.top;
  if (bx < 0 || by < 0 || bx >= rect.width || by >= rect.height) return null;
  let file = Math.floor(bx / size);
  let rank = 7 - Math.floor(by / size);
  if (flipped) { file = 7 - file; rank = 7 - rank; }
  return String.fromCharCode(97 + file) + (rank + 1);
}