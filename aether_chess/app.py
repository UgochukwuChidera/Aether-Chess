from __future__ import annotations

import os
import threading
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import chess
import pygame

from aether_chess.engines.controller import EngineController
from aether_chess.models.game_state import GameState
from aether_chess.models.settings import EngineType, GameMode, GameSettings
from aether_chess.ui.animation import PieceAnimation
from aether_chess.ui.theme import ThemeManager
from aether_chess.ui.pieces import PieceManager

# ── Unicode piece glyphs ────────────────────────────────────────────────────
PIECE_GLYPHS = {
    "P": "♙", "N": "♘", "B": "♗", "R": "♖", "Q": "♕", "K": "♔",
    "p": "♟", "n": "♞", "b": "♝", "r": "♜", "q": "♛", "k": "♚",
}

# ── Layout constants ────────────────────────────────────────────────────────
MIN_SQUARE_SIZE       = 30
MIN_SIDEBAR_W         = 210
MAX_SIDEBAR_W         = 310
MIN_WIDE_LAYOUT_WIDTH = 700
SCROLL_INCREMENT      = 22
DISPLAY_FLAGS         = pygame.RESIZABLE

# ── Palette (dark theme) ────────────────────────────────────────────────────
C_BG          = (13,  13,  13)   # outer background
C_PANEL       = (20,  20,  20)   # sidebar bg
C_SURFACE     = (26,  26,  26)   # card / button base
C_SURFACE2    = (32,  32,  32)   # hover tint
C_BORDER      = (36,  36,  36)   # hairline borders
C_ACCENT      = (0,   188, 212)  # teal accent
C_ACCENT_DIM  = (0,   80,  90)   # dark teal fill for active buttons
C_TEXT        = (220, 220, 215)  # primary text
C_MUTED       = (120, 120, 115)  # secondary text
C_DIM         = (55,  55,  52)   # very muted / coord labels
C_HIGHLIGHT   = (246, 246, 105)  # selected square
C_LASTMOVE    = (240, 192, 64)   # last-move ring
C_HINT        = (186, 202, 68)   # legal-move dot
C_BOARD_L     = (238, 238, 210)  # light square
C_BOARD_D     = (118, 150, 86)   # dark square


ButtonDef = Tuple[str, Callable[[], None], bool, bool, str]  # label, action, needs_sync, start_engine, group


@dataclass
class UIState:
    selected_square: Optional[int] = None
    last_move: Optional[chess.Move] = None
    rotate: bool = False
    scroll_offset: int = 0
    hover_button: int = -1


@dataclass
class UIButton:
    label: str
    action: Callable[[], None]
    rect: pygame.Rect
    needs_sync: bool = True
    start_engine: bool = True
    group: str = "controls"


class AetherChessApp:
    def __init__(self, width: int = 980, height: int = 700):
        pygame.init()
        pygame.font.init()

        self.screen = pygame.display.set_mode((width, height), DISPLAY_FLAGS)
        pygame.display.set_caption("Aether Chess")
        self.clock = pygame.time.Clock()

        self.game_state = GameState()
        self.ui_state = UIState()
        self.theme_manager = ThemeManager("aether_chess/config/default_theme.json")
        self.theme = self.theme_manager.theme

        self.piece_manager = PieceManager()
        self.piece_manager.set_current(self.theme.get("pieces", "set", default="alpha"))

        # placeholders; filled by _recompute_layout()
        self.square_size    = 60
        self.board_origin   = (0, 0)
        self.sidebar_rect   = pygame.Rect(0, 0, 0, 0)
        self.hud_buttons: List[UIButton] = []
        self._btn_sig: Optional[tuple] = None

        self._init_fonts(self.square_size)

        self.animations: Dict[int, PieceAnimation] = {}
        self.running = True

        opening_books_env = os.getenv("AETHER_OPENING_BOOKS", "").strip()
        opening_books = [p.strip() for p in opening_books_env.split(",") if p.strip()]
        self.settings = GameSettings(
            uci_path=os.getenv("AETHER_UCI_PATH", "stockfish"),
            opening_books=opening_books,
        )
        self.engine_controller = EngineController(self.settings)
        self.engine_thread: Optional[threading.Thread] = None
        self.pending_engine_move: Optional[chess.Move] = None
        self.export_dir = Path.cwd() / "exports"

        self._recompute_layout()

    # ── Font helpers ────────────────────────────────────────────────────────

    def _init_fonts(self, sq: int) -> None:
        piece_size = max(16, sq - 6)
        self.piece_font  = pygame.font.SysFont("DejaVu Sans,Segoe UI Symbol,Arial Unicode MS", piece_size)
        self.ui_font     = pygame.font.SysFont("Arial,Helvetica,sans-serif", max(13, min(16, sq // 4 + 4)))
        self.small_font  = pygame.font.SysFont("Arial,Helvetica,sans-serif", max(10, min(13, sq // 5 + 3)))
        self.micro_font  = pygame.font.SysFont("Arial,Helvetica,sans-serif", max(9,  min(11, sq // 6 + 2)))
        self.title_font  = pygame.font.SysFont("Georgia,Times New Roman,serif", max(14, min(18, sq // 4 + 6)))
        self.coord_font  = pygame.font.SysFont("Arial,Helvetica,sans-serif", max(9,  min(12, sq // 6 + 2)))

    # ── Layout ──────────────────────────────────────────────────────────────

    def _recompute_layout(self) -> None:
        W, H = self.screen.get_size()
        margin = 16

        # Sidebar width: clamp between min/max, ~27% of window
        sb_w = max(MIN_SIDEBAR_W, min(MAX_SIDEBAR_W, int(W * 0.27)))

        # Board: fill remaining space, keep square
        coord_gutter = 20   # rank labels left, file labels bottom
        player_h     = 34   # each player strip height
        avail_w = W - sb_w - 3 * margin - coord_gutter
        avail_h = H - 2 * margin - coord_gutter - 2 * (player_h + 6)
        sq = max(MIN_SQUARE_SIZE, min(avail_w, avail_h) // 8)
        board_px = sq * 8

        # Center the board+coord block vertically and horizontally in its column
        total_board_h = 2 * (player_h + 6) + coord_gutter + board_px
        board_block_y = margin + max(0, (H - 2 * margin - total_board_h) // 2)
        board_block_x = margin + coord_gutter  # leave room for rank labels

        self.square_size  = sq
        self.board_origin = (board_block_x, board_block_y + player_h + 6)
        self._player_strip_w = board_px + coord_gutter
        self._player_strip_x = margin
        self._black_strip_y  = board_block_y
        self._white_strip_y  = board_block_y + player_h + 6 + board_px + 6
        self._player_h       = player_h
        self._coord_gutter   = coord_gutter
        self._board_px       = board_px
        self._block_y        = board_block_y
        self._margin         = margin

        # Sidebar
        sb_x = margin + coord_gutter + board_px + margin
        self.sidebar_rect = pygame.Rect(sb_x, margin, W - sb_x - margin, H - 2 * margin)

        self.ui_state.scroll_offset = 0
        self._btn_sig = None
        self._init_fonts(sq)

    # ── Engine helpers ──────────────────────────────────────────────────────

    def _sync_engine_settings(self) -> None:
        self.engine_controller.apply_settings(self.settings)

    def _is_ai_turn(self) -> bool:
        return (not self.game_state.board.is_game_over()
                and not self.settings.is_human_turn(self.game_state.board))

    def _cycle_uci_path(self) -> None:
        candidates = ["stockfish", "/usr/games/stockfish",
                      "stockfish/stockfish", "stockfish/stockfish.exe"]
        if self.settings.uci_path not in candidates:
            candidates.insert(0, self.settings.uci_path)
        idx = candidates.index(self.settings.uci_path)
        self.settings.uci_path = candidates[(idx + 1) % len(candidates)]
        self._sync_engine_settings()

    def _undo_last(self) -> None:
        if self.settings.game_mode == GameMode.HUMAN_VS_AI:
            self.game_state.pop(); self.game_state.pop()
        else:
            self.game_state.pop()

    # ── Button definitions (group → section heading) ─────────────────────

    def _button_defs(self) -> List[ButtonDef]:
        return [
            # label, action, needs_sync, start_engine, group
            ("Mode",       self.settings.cycle_mode,            True,  True,  "game"),
            ("Engine",     self.settings.cycle_engine_type,     True,  True,  "game"),
            ("Opening",    self.settings.cycle_opening_strategy,True,  True,  "game"),
            ("Side",       self.settings.cycle_human_color,     True,  True,  "game"),
            ("Rotate",     lambda: setattr(self.ui_state, "rotate", not self.ui_state.rotate), False, False, "board"),
            ("Undo",       self._undo_last,                     False, True,  "board"),
            ("Book Mode",  self.settings.cycle_book_mode,       True,  True,  "book"),
            ("Next Book",  self.settings.cycle_active_book,     True,  True,  "book"),
            ("Threads +",  lambda: self.settings.bump_threads(1),  True, True, "engine"),
            ("Threads −",  lambda: self.settings.bump_threads(-1), True, True, "engine"),
            ("Move +100",  lambda: self.settings.bump_movetime(100),  True, True, "engine"),
            ("Move −100",  lambda: self.settings.bump_movetime(-100), True, True, "engine"),
            ("Path",       self._cycle_uci_path,                False, False, "engine"),
            ("FEN",        self.export_fen,                     False, False, "export"),
            ("PGN",        self.export_pgn,                     False, False, "export"),
            ("Image",      self.export_screenshot,              False, False, "export"),
        ]

    def _invoke_button(self, btn: UIButton) -> None:
        btn.action()
        if btn.needs_sync:
            self._sync_engine_settings()
        if btn.start_engine:
            self.start_engine_reply()

    # ── Coordinate / screen helpers ─────────────────────────────────────────

    def square_to_screen(self, square: int) -> Tuple[int, int]:
        file = chess.square_file(square)
        rank = chess.square_rank(square)
        if self.ui_state.rotate:
            file, rank = 7 - file, 7 - rank
        x = self.board_origin[0] + file * self.square_size
        y = self.board_origin[1] + (7 - rank) * self.square_size
        return x, y

    def screen_to_square(self, x: int, y: int) -> Optional[int]:
        rx = x - self.board_origin[0]
        ry = y - self.board_origin[1]
        if rx < 0 or ry < 0:
            return None
        f = rx // self.square_size
        rt = ry // self.square_size
        if f > 7 or rt > 7:
            return None
        rank = 7 - rt
        if self.ui_state.rotate:
            f, rank = 7 - f, 7 - rank
        return chess.square(f, rank)

    def _push_with_animation(self, move: chess.Move) -> None:
        fx, fy = self.square_to_screen(move.from_square)
        tx, ty = self.square_to_screen(move.to_square)
        self.animations[move.to_square] = PieceAnimation(fx, fy, tx, ty, 160)
        self.game_state.push(move)
        self.ui_state.last_move = move

    def start_engine_reply(self) -> None:
        if not self._is_ai_turn() or (self.engine_thread and self.engine_thread.is_alive()):
            return
        def worker():
            self.pending_engine_move = self.engine_controller.choose_move(
                self.game_state.board.copy(stack=False))
        self.engine_thread = threading.Thread(target=worker, daemon=True)
        self.engine_thread.start()

    def apply_engine_reply_if_ready(self) -> None:
        if self.pending_engine_move:
            if self.pending_engine_move in self.game_state.board.legal_moves:
                self._push_with_animation(self.pending_engine_move)
            self.pending_engine_move = None
            if self.settings.game_mode == GameMode.AI_VS_AI:
                self.start_engine_reply()

    # ── Drawing ─────────────────────────────────────────────────────────────

    def _draw_rect(self, color, rect, radius=0, width=0):
        pygame.draw.rect(self.screen, color, rect,
                         border_radius=radius, width=width)

    def _blit_text(self, text, font, color, x, y, center=False):
        surf = font.render(text, True, color)
        if center:
            x -= surf.get_width() // 2
        self.screen.blit(surf, (x, y))
        return surf.get_width(), surf.get_height()

    def draw_player_strip(self, y: int, is_white: bool, is_active: bool) -> None:
        x  = self._player_strip_x
        w  = self._player_strip_w
        h  = self._player_h
        r  = pygame.Rect(x, y, w, h)
        bg = C_ACCENT_DIM if is_active else C_SURFACE
        bc = C_ACCENT    if is_active else C_BORDER
        self._draw_rect(bg, r, radius=7)
        self._draw_rect(bc, r, radius=7, width=1)

        # colour dot
        dot_x = x + 10
        dot_y = y + h // 2
        dot_r = 5
        pygame.draw.circle(self.screen, (240, 240, 232) if is_white else (28, 28, 28), (dot_x, dot_y), dot_r)
        pygame.draw.circle(self.screen, (140, 140, 130) if is_white else (90, 90, 86), (dot_x, dot_y), dot_r, 1)

        label = "You (White)" if is_white else "AI (Black)" if self.settings.game_mode == GameMode.HUMAN_VS_AI else ("White" if is_white else "Black")
        self._blit_text(label, self.small_font, C_TEXT if is_active else C_MUTED, dot_x + dot_r + 8, y + (h - self.small_font.get_height()) // 2)

        if is_active:
            tag_text = "YOUR TURN" if self.settings.is_human_turn(self.game_state.board) else "THINKING…"
            tag_surf = self.micro_font.render(tag_text, True, C_ACCENT if is_active and not self._is_ai_turn() else C_MUTED)
            tx = x + w - tag_surf.get_width() - 10
            ty = y + (h - tag_surf.get_height()) // 2
            if not self._is_ai_turn():
                tr = pygame.Rect(tx - 5, ty - 2, tag_surf.get_width() + 10, tag_surf.get_height() + 4)
                self._draw_rect(C_ACCENT_DIM, tr, radius=4)
            self.screen.blit(tag_surf, (tx, ty))

    def draw_board(self) -> None:
        ox, oy = self.board_origin
        sq = self.square_size

        # ── Squares ────────────────────────────────────────────────────────
        legal_targets: set = set()
        if self.ui_state.selected_square is not None:
            for m in self.game_state.board.legal_moves:
                if m.from_square == self.ui_state.selected_square:
                    legal_targets.add(m.to_square)

        for rank in range(8):
            for file in range(8):
                square = chess.square(file, 7 - rank)
                sx, sy = self.square_to_screen(square)
                is_light = (file + rank) % 2 == 0
                col = C_BOARD_L if is_light else C_BOARD_D

                # last-move tint
                if (self.ui_state.last_move
                        and square in (self.ui_state.last_move.from_square,
                                       self.ui_state.last_move.to_square)):
                    col = tuple(min(255, int(c * 0.82 + lm * 0.18))
                                for c, lm in zip(col, C_LASTMOVE))

                self._draw_rect(col, (sx, sy, sq, sq))

                # selected highlight
                if self.ui_state.selected_square == square:
                    self._draw_rect(C_HIGHLIGHT, (sx, sy, sq, sq))

                # legal-move dots
                if square in legal_targets:
                    piece_here = self.game_state.board.piece_at(square)
                    if piece_here:
                        pygame.draw.rect(self.screen, (*C_LASTMOVE, 140),
                                         (sx, sy, sq, sq),
                                         width=3, border_radius=0)
                    else:
                        dot_r = max(4, sq // 7)
                        pygame.draw.circle(self.screen, (*C_HINT, 160),
                                           (sx + sq // 2, sy + sq // 2), dot_r)

        # ── Coordinate labels ──────────────────────────────────────────────
        files_str = "abcdefgh"
        ranks_str = "87654321"
        if self.ui_state.rotate:
            files_str = files_str[::-1]
            ranks_str = ranks_str[::-1]

        for i, letter in enumerate(files_str):
            lx = ox + i * sq + sq // 2
            ly = oy + 8 * sq + 3
            surf = self.coord_font.render(letter, True, C_DIM)
            self.screen.blit(surf, (lx - surf.get_width() // 2, ly))

        for i, num in enumerate(ranks_str):
            lx = ox - self.coord_font.size(num)[0] - 4
            ly = oy + i * sq + (sq - self.coord_font.get_height()) // 2
            self.screen.blit(self.coord_font.render(num, True, C_DIM), (lx, ly))

        # ── Board border ───────────────────────────────────────────────────
        pygame.draw.rect(self.screen, C_BORDER,
                         (ox - 1, oy - 1, sq * 8 + 2, sq * 8 + 2), width=1)

    def draw_pieces(self, dt_ms: int = 16) -> None:
        sq = self.square_size
        for square, piece in self.game_state.board.piece_map().items():
            sx, sy = self.square_to_screen(square)
            anim = self.animations.get(square)
            if anim:
                sx, sy, done = anim.tick(dt_ms)
                if done:
                    self.animations.pop(square, None)

            piece_set = str(self.theme.get("pieces", "set", default="alpha")).lower()
            if piece_set == "unicode":
                glyph = PIECE_GLYPHS[piece.symbol()]
                col = (20, 20, 20) if piece.color == chess.WHITE else (235, 235, 230)
                shadow = (180, 180, 175) if piece.color == chess.WHITE else (30, 30, 30)
                self.screen.blit(self.piece_font.render(glyph, True, shadow), (sx + 3, sy + 3))
                self.screen.blit(self.piece_font.render(glyph, True, col),    (sx + 2, sy + 2))
            else:
                img = self.piece_manager.get_image(piece.symbol(), sq)
                self.screen.blit(img, (sx, sy))

    # ── Sidebar ──────────────────────────────────────────────────────────────

    def _sidebar_section_header(self, x, y, w, text) -> int:
        """Draw a section label; return new y."""
        surf = self.micro_font.render(text.upper(), True, C_DIM)
        self.screen.blit(surf, (x, y))
        return y + surf.get_height() + 5

    def _draw_strength_pip_row(self, x, y, w) -> int:
        level = self.settings.ai_strength
        label_surf = self.small_font.render(f"{level}/10", True, C_MUTED)
        self.screen.blit(label_surf, (x, y + 2))
        pip_x = x + label_surf.get_width() + 8
        btn_w = 18
        gap = 3
        # two mini buttons on the right
        minus_r = pygame.Rect(x + w - btn_w * 2 - gap, y, btn_w, 18)
        plus_r  = pygame.Rect(x + w - btn_w,           y, btn_w, 18)

        pip_total_w = minus_r.x - pip_x - 8
        pip_h = 4
        pip_gap = 2
        single_pip_w = max(4, (pip_total_w - 9 * pip_gap) // 10)

        for i in range(10):
            px = pip_x + i * (single_pip_w + pip_gap)
            py = y + (18 - pip_h) // 2
            col = C_ACCENT if i < level else C_SURFACE2
            self._draw_rect(col, (px, py, single_pip_w, pip_h), radius=2)

        for rect, lbl, action in [
            (minus_r, "−", lambda: (self.settings.bump_strength(-1), self._sync_engine_settings())),
            (plus_r,  "+", lambda: (self.settings.bump_strength(1),  self._sync_engine_settings())),
        ]:
            is_hov = rect.collidepoint(pygame.mouse.get_pos())
            self._draw_rect(C_SURFACE2 if is_hov else C_SURFACE, rect, radius=4)
            self._draw_rect(C_BORDER, rect, radius=4, width=1)
            ls = self.ui_font.render(lbl, True, C_ACCENT if is_hov else C_MUTED)
            self.screen.blit(ls, (rect.x + (rect.w - ls.get_width()) // 2,
                                  rect.y + (rect.h - ls.get_height()) // 2))

        # Register as special buttons
        for rect, action in [(minus_r, lambda: (self.settings.bump_strength(-1), self._sync_engine_settings())),
                             (plus_r,  lambda: (self.settings.bump_strength(1),  self._sync_engine_settings()))]:
            # inline: handled in click via direct check
            pass

        self._str_minus_rect = minus_r
        self._str_plus_rect  = plus_r

        return y + 22

    def _build_buttons(self, groups: dict) -> None:
        """groups = {group_name: (x, y, w, cols, btn_h, gap)}"""
        defs = self._button_defs()
        sig = tuple(r for v in groups.values() for r in v)
        if sig == self._btn_sig:
            return
        self._btn_sig = sig
        self.hud_buttons = []
        counters: Dict[str, int] = {}
        for label, action, ns, se, group in defs:
            if group not in groups:
                continue
            x, y, w, cols, btn_h, gap = groups[group]
            idx = counters.get(group, 0)
            col = idx % cols
            row = idx // cols
            bx = x + col * ((w - gap * (cols - 1)) // cols + gap)
            bw = (w - gap * (cols - 1)) // cols
            by = y + row * (btn_h + gap)
            self.hud_buttons.append(UIButton(label, action,
                                             pygame.Rect(bx, by, bw, btn_h),
                                             ns, se, group))
            counters[group] = idx + 1

    def draw_sidebar(self) -> None:
        r = self.sidebar_rect
        # background
        self._draw_rect(C_PANEL, r, radius=10)
        self._draw_rect(C_BORDER, r, radius=10, width=1)

        pad = 12
        x   = r.x + pad
        w   = r.width - 2 * pad
        cy  = r.y + pad
        mouse = pygame.mouse.get_pos()

        # ── Title ──────────────────────────────────────────────────────────
        ts = self.title_font.render("Aether Chess", True, C_ACCENT)
        self.screen.blit(ts, (x, cy))
        version_s = self.micro_font.render("v0.1-alpha", True, C_DIM)
        self.screen.blit(version_s, (r.right - pad - version_s.get_width(), cy + 3))
        cy += ts.get_height() + 8

        # thin divider
        pygame.draw.line(self.screen, C_BORDER, (x, cy), (r.right - pad, cy))
        cy += 8

        # ── Turn / status ──────────────────────────────────────────────────
        if self.game_state.board.is_game_over():
            result = self.game_state.board.result()
            turn_text = f"Game Over  {result}"
            turn_col  = C_MUTED
        elif self.game_state.board.turn == chess.WHITE:
            turn_text = "White to move"
            turn_col  = (230, 230, 225)
        else:
            turn_text = "Black to move"
            turn_col  = C_MUTED

        dot_r = 5
        pygame.draw.circle(self.screen, (230, 230, 225) if self.game_state.board.turn else (50, 50, 48),
                            (x + dot_r, cy + self.ui_font.get_height() // 2 + 1), dot_r)
        pygame.draw.circle(self.screen, C_BORDER,
                            (x + dot_r, cy + self.ui_font.get_height() // 2 + 1), dot_r, 1)
        ts2 = self.ui_font.render(turn_text, True, turn_col)
        self.screen.blit(ts2, (x + dot_r * 2 + 6, cy))
        cy += ts2.get_height() + 10

        # ── Info grid ─────────────────────────────────────────────────────
        cy = self._sidebar_section_header(x, cy, w, "Game Info")
        info = [
            ("Mode",    self.settings.game_mode.value.replace("_", " ").title()),
            ("Engine",  self.settings.engine_type.value.title()),
            ("Opening", self.settings.opening_strategy.value.title()),
            ("Books",   "Auto" if self.settings.auto_rotate_books else f"Fixed #{self.settings.active_book_index+1}"),
        ]
        col_w = w // 2
        for i, (k, v) in enumerate(info):
            col_idx = i % 2
            row_idx = i // 2
            kx = x + col_idx * col_w
            ky = cy + row_idx * (self.small_font.get_height() + 4)
            self.screen.blit(self.small_font.render(k, True, C_DIM),   (kx, ky))
            self.screen.blit(self.small_font.render(v, True, C_MUTED), (kx + 42, ky))
        info_rows = (len(info) + 1) // 2
        cy += info_rows * (self.small_font.get_height() + 4) + 8

        # divider
        pygame.draw.line(self.screen, C_BORDER, (x, cy), (r.right - pad, cy)); cy += 8

        # ── Strength ───────────────────────────────────────────────────────
        cy = self._sidebar_section_header(x, cy, w, "Strength")
        cy = self._draw_strength_pip_row(x, cy, w)
        cy += 8

        pygame.draw.line(self.screen, C_BORDER, (x, cy), (r.right - pad, cy)); cy += 8

        # ── Controls ──────────────────────────────────────────────────────
        cy = self._sidebar_section_header(x, cy, w, "Controls")
        btn_h = max(22, min(28, self.small_font.get_height() + 10))
        gap   = 4
        cols  = 2
        bw    = (w - gap) // cols
        game_groups = {
            "game":   (x, cy, w, cols, btn_h, gap),
            "board":  (x, cy + 2 * (btn_h + gap), w, cols, btn_h, gap),
            "book":   (x, cy + 4 * (btn_h + gap), w, cols, btn_h, gap),
            "engine": (x, cy + 6 * (btn_h + gap), w, cols, btn_h, gap),
        }
        self._build_buttons(game_groups)

        # draw buttons
        section_order = ["game", "board", "book", "engine"]
        section_names = {"game": None, "board": None, "book": None, "engine": None}  # no sub-labels; all under Controls
        for btn in self.hud_buttons:
            is_hov = btn.rect.collidepoint(mouse)
            bg = C_ACCENT_DIM if is_hov else C_SURFACE
            bc = C_ACCENT     if is_hov else C_BORDER
            self._draw_rect(bg, btn.rect, radius=6)
            self._draw_rect(bc, btn.rect, radius=6, width=1)
            ls = self.micro_font.render(btn.label, True, C_ACCENT if is_hov else C_MUTED)
            self.screen.blit(ls, (btn.rect.x + (btn.rect.w - ls.get_width()) // 2,
                                  btn.rect.y + (btn.rect.h - ls.get_height()) // 2))

        cy += 8 * (btn_h + gap) + 6

        pygame.draw.line(self.screen, C_BORDER, (x, cy), (r.right - pad, cy)); cy += 8

        # ── Export ────────────────────────────────────────────────────────
        cy = self._sidebar_section_header(x, cy, w, "Export")
        export_defs = [d for d in self._button_defs() if d[4] == "export"]
        export_btn_h = btn_h
        export_bw    = (w - 2 * gap) // 3
        for i, (label, action, ns, se, _) in enumerate(export_defs):
            bx = x + i * (export_bw + gap)
            br = pygame.Rect(bx, cy, export_bw, export_btn_h)
            is_hov = br.collidepoint(mouse)
            self._draw_rect(C_ACCENT_DIM if is_hov else C_SURFACE, br, radius=6)
            self._draw_rect(C_ACCENT if is_hov else C_BORDER, br, radius=6, width=1)
            ls = self.micro_font.render(label, True, C_ACCENT if is_hov else C_MUTED)
            self.screen.blit(ls, (br.x + (br.w - ls.get_width()) // 2,
                                  br.y + (br.h - ls.get_height()) // 2))
            # Register export buttons into hud_buttons for click handling
            existing = [b for b in self.hud_buttons if b.label == label]
            if not existing:
                self.hud_buttons.append(UIButton(label, action, br, ns, se, "export"))
            else:
                existing[0].rect = br

        cy += export_btn_h + 8
        pygame.draw.line(self.screen, C_BORDER, (x, cy), (r.right - pad, cy)); cy += 8

        # ── Move list ─────────────────────────────────────────────────────
        remaining_h = r.bottom - cy - pad
        if remaining_h > 40:
            cy = self._sidebar_section_header(x, cy, w, "Move History")
            list_h = r.bottom - cy - pad - self.micro_font.get_height() - 6
            list_rect = pygame.Rect(x - 2, cy, w + 4, list_h)
            self._draw_rect(C_BG, list_rect, radius=6)
            self._draw_rect(C_BORDER, list_rect, radius=6, width=1)
            self._draw_move_list(list_rect)
            cy = list_rect.bottom + 6

        # ── Status bar ────────────────────────────────────────────────────
        status = self.engine_controller.last_error or self.engine_controller.status
        if len(status) > 38:
            status = status[:35] + "…"
        ss = self.micro_font.render(status, True, C_DIM)
        self.screen.blit(ss, (x, r.bottom - pad - ss.get_height()))

    def _draw_move_list(self, rect: pygame.Rect) -> None:
        moves = list(self.game_state.board.move_stack)
        line_h = self.small_font.get_height() + 3
        num_visible = max(1, rect.height // line_h)
        total_pairs = (len(moves) + 1) // 2

        max_offset = max(0, total_pairs - num_visible)
        self.ui_state.scroll_offset = min(self.ui_state.scroll_offset, max_offset)
        start_pair = self.ui_state.scroll_offset

        # clip
        clip = self.screen.get_clip()
        self.screen.set_clip(rect.inflate(-4, -4))

        x  = rect.x + 6
        cy = rect.y + 4

        for pair_idx in range(start_pair, min(total_pairs, start_pair + num_visible + 1)):
            mi = pair_idx * 2
            is_current = mi >= len(moves) - 2

            if is_current:
                hr = pygame.Rect(rect.x + 2, cy - 1, rect.width - 4, line_h + 1)
                self._draw_rect(C_SURFACE, hr, radius=4)

            # move number
            ns = self.small_font.render(f"{pair_idx + 1}.", True, C_DIM)
            self.screen.blit(ns, (x, cy))

            # white move
            if mi < len(moves):
                wmv = moves[mi].uci()
                wc  = C_ACCENT if is_current and self.game_state.board.turn == chess.BLACK else C_TEXT
                ws  = self.small_font.render(wmv, True, wc)
                self.screen.blit(ws, (x + 24, cy))

            # black move
            if mi + 1 < len(moves):
                bmv = moves[mi + 1].uci()
                bc  = C_ACCENT if is_current and self.game_state.board.turn == chess.WHITE else C_MUTED
                bs  = self.small_font.render(bmv, True, bc)
                self.screen.blit(bs, (x + 68, cy))

            cy += line_h

        self.screen.set_clip(clip)

    def render(self, dt_ms: int = 16) -> None:
        self.screen.fill(C_BG)

        # player strips
        white_turn = self.game_state.board.turn == chess.WHITE
        self.draw_player_strip(self._black_strip_y, is_white=False, is_active=not white_turn)
        self.draw_player_strip(self._white_strip_y, is_white=True,  is_active=white_turn)

        self.draw_board()
        self.draw_pieces(dt_ms)
        self.draw_sidebar()
        pygame.display.flip()

    # ── Input ───────────────────────────────────────────────────────────────

    def _handle_button_click(self, x: int, y: int) -> bool:
        # Strength pips
        if hasattr(self, "_str_minus_rect") and self._str_minus_rect.collidepoint(x, y):
            self.settings.bump_strength(-1); self._sync_engine_settings(); return True
        if hasattr(self, "_str_plus_rect")  and self._str_plus_rect.collidepoint(x, y):
            self.settings.bump_strength(1);  self._sync_engine_settings(); return True
        for btn in self.hud_buttons:
            if btn.rect.collidepoint(x, y):
                self._invoke_button(btn); return True
        return False

    def handle_click(self, x: int, y: int) -> None:
        if self._handle_button_click(x, y):
            return
        if not self.settings.is_human_turn(self.game_state.board):
            return
        sq = self.screen_to_square(x, y)
        if sq is None:
            return
        piece = self.game_state.board.piece_at(sq)
        if self.ui_state.selected_square is None:
            if piece and piece.color == self.game_state.board.turn:
                self.ui_state.selected_square = sq
            return
        for move in [chess.Move(self.ui_state.selected_square, sq),
                     chess.Move(self.ui_state.selected_square, sq, promotion=chess.QUEEN)]:
            if move in self.game_state.board.legal_moves:
                self._push_with_animation(move)
                self.ui_state.selected_square = None
                self.start_engine_reply()
                return
        self.ui_state.selected_square = (sq if piece and piece.color == self.game_state.board.turn else None)

    # ── Exports ─────────────────────────────────────────────────────────────

    def _timestamp(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")

    def _copy_to_clipboard(self, text: str) -> bool:
        try:
            if not pygame.scrap.get_init():
                pygame.scrap.init()
            pygame.scrap.put_text(text)
            return True
        except Exception:
            return False

    def export_fen(self) -> str:
        fen = self.game_state.to_fen()
        self.export_dir.mkdir(parents=True, exist_ok=True)
        out = self.export_dir / f"aether-fen-{self._timestamp()}.txt"
        out.write_text(fen + "\n", encoding="utf-8")
        self._copy_to_clipboard(fen)
        self.engine_controller.status = f"FEN exported: {out.name}"
        return str(out)

    def export_pgn(self) -> str:
        pgn = self.game_state.to_pgn()
        self.export_dir.mkdir(parents=True, exist_ok=True)
        out = self.export_dir / f"aether-game-{self._timestamp()}.pgn"
        out.write_text(pgn + "\n", encoding="utf-8")
        self._copy_to_clipboard(pgn)
        self.engine_controller.status = f"PGN exported: {out.name}"
        return str(out)

    def export_screenshot(self) -> str:
        self.export_dir.mkdir(parents=True, exist_ok=True)
        out = self.export_dir / f"aether-board-{self._timestamp()}.png"
        self.render(16)
        pygame.image.save(self.screen, str(out))
        self.engine_controller.status = f"Image: {out.name}"
        return str(out)

    def save_screenshot(self, path: str) -> str:
        self.render(16)
        pygame.image.save(self.screen, path)
        return path

    # ── Main loop ───────────────────────────────────────────────────────────

    def run(self) -> None:
        self.start_engine_reply()
        while self.running:
            dt = self.clock.tick(60)
            self.apply_engine_reply_if_ready()
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    self.running = False
                elif event.type == pygame.MOUSEBUTTONDOWN:
                    if event.button == 1:
                        self.handle_click(*event.pos)
                    elif event.button == 4:
                        self.ui_state.scroll_offset = max(0, self.ui_state.scroll_offset - 1)
                    elif event.button == 5:
                        self.ui_state.scroll_offset += 1
                elif event.type == pygame.VIDEORESIZE:
                    self.screen = pygame.display.set_mode((event.w, event.h), DISPLAY_FLAGS)
                    self._recompute_layout()
                elif event.type == pygame.KEYDOWN:
                    self._handle_key(event.key)
            self.render(dt)
        self.engine_controller.stop_uci()
        pygame.quit()

    def _handle_key(self, key: int) -> None:
        km = {
            pygame.K_r: lambda: setattr(self.ui_state, "rotate", not self.ui_state.rotate),
            pygame.K_u: self._undo_last,
            pygame.K_m: lambda: (self.settings.cycle_mode(), self._sync_engine_settings()),
            pygame.K_e: lambda: (self.settings.cycle_engine_type(), self._sync_engine_settings()),
            pygame.K_s: lambda: (self.settings.bump_strength(1), self._sync_engine_settings()),
            pygame.K_a: lambda: (self.settings.bump_strength(-1), self._sync_engine_settings()),
            pygame.K_o: lambda: (self.settings.cycle_opening_strategy(), self._sync_engine_settings()),
            pygame.K_c: lambda: (self.settings.cycle_human_color(), self._sync_engine_settings()),
            pygame.K_b: lambda: (self.settings.cycle_book_mode(), self._sync_engine_settings()),
            pygame.K_n: lambda: (self.settings.cycle_active_book(), self._sync_engine_settings()),
            pygame.K_t: lambda: (self.settings.bump_threads(1), self._sync_engine_settings()),
            pygame.K_g: lambda: (self.settings.bump_threads(-1), self._sync_engine_settings()),
            pygame.K_y: lambda: (self.settings.bump_movetime(100), self._sync_engine_settings()),
            pygame.K_h: lambda: (self.settings.bump_movetime(-100), self._sync_engine_settings()),
            pygame.K_p: self._cycle_uci_path,
            pygame.K_f: self.export_fen,
            pygame.K_j: self.export_pgn,
            pygame.K_i: self.export_screenshot,
        }
        if key in km:
            km[key]()
            self.start_engine_reply()