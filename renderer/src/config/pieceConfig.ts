/**
 * pieceConfig.ts — Centralised board-palette and piece-set definitions.
 *
 * All components that need board colours or piece-rendering details should
 * import from here rather than keeping their own hard-coded maps.
 */

// ── Board Styles ──────────────────────────────────────────────────────────────

export type BoardStyle =
  | 'classic'
  | 'wood'
  | 'marble'
  | 'neon'
  | 'ice'
  | 'forest'
  | 'tournament'
  | 'aether';

export interface BoardStyleConfig {
  light: string;
  dark: string;
  label: string;
}

export const BOARD_STYLES: Record<BoardStyle, BoardStyleConfig> = {
  classic:    { light: '#EDE8D5', dark: '#B58863', label: 'Classic' },
  wood:       { light: '#F0D9B5', dark: '#B58863', label: 'Wood' },
  marble:     { light: '#D8D8D8', dark: '#8B8B8B', label: 'Marble' },
  neon:       { light: '#1D2A1F', dark: '#111A12', label: 'Neon' },
  ice:        { light: '#D6EEF8', dark: '#6BAED6', label: 'Ice' },
  forest:     { light: '#C8DDB5', dark: '#4A6741', label: 'Forest' },
  tournament: { light: '#F0EAD6', dark: '#769656', label: 'Tournament' },
  aether:     { light: '#1A2535', dark: '#0D1520', label: 'Aether' },
};

// ── Piece Sets ────────────────────────────────────────────────────────────────

export type PieceSet = 'material' | 'alpha' | 'neo';

export interface PieceSetConfig {
  label: string;
}

export const PIECE_SETS: Record<PieceSet, PieceSetConfig> = {
  material: { label: 'Material Symbols' },
  alpha:    { label: 'Alpha' },
  neo:      { label: 'Neo (Coloured)' },
};

// ── Piece Glyph Maps ──────────────────────────────────────────────────────────

/** Unicode chess symbols used by the "alpha" and "neo" piece sets. */
export const PIECE_GLYPHS: Record<string, string> = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};

/** Google Material Symbols icon names used by the "material" piece set. */
export const PIECE_ICONS: Record<string, string> = {
  P: 'chess_pawn',   N: 'chess_knight', B: 'chess_bishop',
  R: 'chess_rook',   Q: 'chess_queen',  K: 'chess_king',
  p: 'chess_pawn',   n: 'chess_knight', b: 'chess_bishop',
  r: 'chess_rook',   q: 'chess_queen',  k: 'chess_king',
};
