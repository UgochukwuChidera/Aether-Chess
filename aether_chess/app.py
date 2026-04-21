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

PIECE_GLYPHS = {
    "P": "♙", "N": "♘", "B": "♗", "R": "♖", "Q": "♕", "K": "♔",
    "p": "♟", "n": "♞", "b": "♝", "r": "♜", "q": "♛", "k": "♚",
}
STATUS_MAX_LENGTH = 30
STATUS_TRUNCATE_LENGTH = 27
MIN_SQUARE_SIZE = 30
MIN_STACKED_HUD_HEIGHT = 190
MIN_HUD_WIDTH = 260
MAX_HUD_WIDTH = 360
MIN_TWO_COLUMN_BUTTON_WIDTH = 300
MOVE_LIST_PADDING = 8
MOVE_LIST_EXTRA_WIDTH = 2
SCROLL_INCREMENT = 24
DISPLAY_FLAGS = pygame.RESIZABLE
MIN_WIDE_LAYOUT_WIDTH = 940

ButtonDef = Tuple[str, Callable[[], None], bool, bool]


@dataclass
class UIState:
    selected_square: Optional[int] = None
    last_move: Optional[chess.Move] = None
    rotate: bool = False
    scroll_offset: int = 0


@dataclass
class UIButton:
    label: str
    action: Callable[[], None]
    rect: pygame.Rect
    needs_sync: bool = True
    start_engine: bool = True


class AetherChessApp:
    def __init__(self, width: int = 960, height: int = 720):
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

        self.square_size = min(height - 40, 640) // 8
        self.board_origin = (20, 20)
        # Layout-driven placeholders. Real values are set in _recompute_layout().
        self.hud_rect = pygame.Rect(0, 0, 0, 0)
        self.moves_rect = pygame.Rect(0, 0, 0, 0)
        self.hud_buttons: List[UIButton] = []
        self._button_layout_signature: Optional[Tuple[int, ...]] = None

        self.piece_font = pygame.font.SysFont("DejaVu Sans,Segoe UI Symbol,Arial Unicode MS", self.square_size - 8)
        self.text_font = pygame.font.SysFont("Arial", 20)

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

    def _recompute_layout(self) -> None:
        # Layout scales down to keep board + HUD usable on small windows.
        width, height = self.screen.get_size()
        margin = max(10, min(width, height) // 50)
        stacked = width < MIN_WIDE_LAYOUT_WIDTH
        if stacked:
            board_space_h = max(8 * MIN_SQUARE_SIZE, height - (4 * margin + MIN_STACKED_HUD_HEIGHT))
            board_px = min(width - 2 * margin, board_space_h)
            self.square_size = max(MIN_SQUARE_SIZE, board_px // 8)
            board_px = self.square_size * 8
            self.board_origin = (max(margin, (width - board_px) // 2), margin)
            hud_y = self.board_origin[1] + board_px + margin
            hud_h = max(120, height - hud_y - margin)
            self.hud_rect = pygame.Rect(margin, hud_y, width - 2 * margin, hud_h)
        else:
            target_hud_w = max(MIN_HUD_WIDTH, min(MAX_HUD_WIDTH, width // 3))
            board_space_w = width - target_hud_w - 3 * margin
            board_space_h = height - 2 * margin
            board_px = min(board_space_w, board_space_h)
            self.square_size = max(MIN_SQUARE_SIZE, board_px // 8)
            board_px = self.square_size * 8
            self.board_origin = (margin, max(margin, (height - board_px) // 2))
            hud_x = self.board_origin[0] + board_px + margin
            hud_w = max(220, width - hud_x - margin)
            self.hud_rect = pygame.Rect(hud_x, margin, hud_w, height - 2 * margin)

        self.ui_state.scroll_offset = max(0, self.ui_state.scroll_offset)
        self.piece_font = pygame.font.SysFont("DejaVu Sans,Segoe UI Symbol,Arial Unicode MS", max(16, self.square_size - 8))
        self.text_font = pygame.font.SysFont("Arial", max(15, min(22, self.square_size // 2)))

    def _sync_engine_settings(self) -> None:
        self.engine_controller.apply_settings(self.settings)

    def _is_ai_turn(self) -> bool:
        if self.game_state.board.is_game_over():
            return False
        return not self.settings.is_human_turn(self.game_state.board)

    def _cycle_uci_path(self) -> None:
        candidates = [
            self.settings.uci_path,
            "stockfish",
            "/usr/games/stockfish",
            "stockfish/stockfish",
            "stockfish/stockfish.exe",
        ]
        unique = []
        for p in candidates:
            if p not in unique:
                unique.append(p)
        idx = unique.index(self.settings.uci_path) if self.settings.uci_path in unique else 0
        self.settings.uci_path = unique[(idx + 1) % len(unique)]
        self._sync_engine_settings()

    def _undo_last(self) -> None:
        if self.settings.game_mode == GameMode.HUMAN_VS_AI:
            self.game_state.pop()
            self.game_state.pop()
        else:
            self.game_state.pop()

    def _button_defs(self) -> List[ButtonDef]:
        return [
            ("Rotate", lambda: setattr(self.ui_state, "rotate", not self.ui_state.rotate), False, False),
            ("Undo", self._undo_last, False, True),
            ("Mode", self.settings.cycle_mode, True, True),
            ("Engine", self.settings.cycle_engine_type, True, True),
            ("Strength +", lambda: self.settings.bump_strength(1), True, True),
            ("Strength -", lambda: self.settings.bump_strength(-1), True, True),
            ("Opening", self.settings.cycle_opening_strategy, True, True),
            ("Side", self.settings.cycle_human_color, True, True),
            ("Book Mode", self.settings.cycle_book_mode, True, True),
            ("Next Book", self.settings.cycle_active_book, True, True),
            ("Threads +", lambda: self.settings.bump_threads(1), True, True),
            ("Threads -", lambda: self.settings.bump_threads(-1), True, True),
            ("Move +100", lambda: self.settings.bump_movetime(100), True, True),
            ("Move -100", lambda: self.settings.bump_movetime(-100), True, True),
            ("Path", self._cycle_uci_path, False, False),
            ("Export FEN", self.export_fen, False, False),
            ("Export PGN", self.export_pgn, False, False),
            ("Export Image", self.export_screenshot, False, False),
        ]

    def _invoke_button_action(self, action: Callable[[], None], needs_sync: bool, start_engine: bool) -> None:
        action()
        if needs_sync:
            self._sync_engine_settings()
        if start_engine:
            self.start_engine_reply()

    def _handle_button_click(self, x: int, y: int) -> bool:
        for button in self.hud_buttons:
            if button.rect.collidepoint(x, y):
                self._invoke_button_action(button.action, button.needs_sync, button.start_engine)
                return True
        return False

    def _ensure_hud_buttons(self, x: int, y: int, width: int, cols: int, button_w: int, button_h: int, gap: int) -> None:
        """Build and cache HUD button rectangles when the layout signature changes."""
        defs = self._button_defs()
        signature = (x, y, width, cols, button_w, button_h, gap, len(defs))
        if signature == self._button_layout_signature:
            return
        self._button_layout_signature = signature
        self.hud_buttons = []
        for idx, (label, action, needs_sync, start_engine) in enumerate(defs):
            col = idx % cols
            row = idx // cols
            bx = x + col * (button_w + gap)
            by = y + row * (button_h + gap)
            rect = pygame.Rect(bx, by, button_w, button_h)
            self.hud_buttons.append(
                UIButton(label=label, action=action, rect=rect, needs_sync=needs_sync, start_engine=start_engine)
            )

    def square_to_screen(self, square: int) -> Tuple[int, int]:
        file = chess.square_file(square)
        rank = chess.square_rank(square)
        if self.ui_state.rotate:
            file = 7 - file
            rank = 7 - rank
        x = self.board_origin[0] + file * self.square_size
        y = self.board_origin[1] + (7 - rank) * self.square_size
        return x, y

    def screen_to_square(self, x: int, y: int) -> Optional[int]:
        rel_x = x - self.board_origin[0]
        rel_y = y - self.board_origin[1]
        if rel_x < 0 or rel_y < 0:
            return None
        file = rel_x // self.square_size
        rank_from_top = rel_y // self.square_size
        if file > 7 or rank_from_top > 7:
            return None
        rank = 7 - rank_from_top
        if self.ui_state.rotate:
            file = 7 - file
            rank = 7 - rank
        return chess.square(file, rank)

    def _push_with_animation(self, move: chess.Move) -> None:
        from_x, from_y = self.square_to_screen(move.from_square)
        to_x, to_y = self.square_to_screen(move.to_square)
        self.animations[move.to_square] = PieceAnimation(from_x, from_y, to_x, to_y, 180)
        self.game_state.push(move)
        self.ui_state.last_move = move

    def start_engine_reply(self) -> None:
        if not self._is_ai_turn() or (self.engine_thread and self.engine_thread.is_alive()):
            return

        def worker() -> None:
            self.pending_engine_move = self.engine_controller.choose_move(self.game_state.board.copy(stack=False))

        self.engine_thread = threading.Thread(target=worker, daemon=True)
        self.engine_thread.start()

    def apply_engine_reply_if_ready(self) -> None:
        if self.pending_engine_move and self.pending_engine_move in self.game_state.board.legal_moves:
            self._push_with_animation(self.pending_engine_move)
        self.pending_engine_move = None
        if self.settings.game_mode == GameMode.AI_VS_AI:
            self.start_engine_reply()

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

        move = chess.Move(self.ui_state.selected_square, sq)
        if move in self.game_state.board.legal_moves:
            self._push_with_animation(move)
            self.ui_state.selected_square = None
            self.start_engine_reply()
            return

        promo = chess.Move(self.ui_state.selected_square, sq, promotion=chess.QUEEN)
        if promo in self.game_state.board.legal_moves:
            self._push_with_animation(promo)
            self.ui_state.selected_square = None
            self.start_engine_reply()
            return

        self.ui_state.selected_square = sq if piece and piece.color == self.game_state.board.turn else None

    def draw_board(self) -> None:
        light = pygame.Color(self.theme.get("board", "light", default="#EEEED2"))
        dark = pygame.Color(self.theme.get("board", "dark", default="#769656"))
        highlight = pygame.Color(self.theme.get("board", "highlight", default="#F6F669"))
        last_move_color = pygame.Color(self.theme.get("board", "last_move", default="#FFD54F"))

        for rank in range(8):
            for file in range(8):
                square = chess.square(file, 7 - rank)
                x, y = self.square_to_screen(square)
                color = light if (file + rank) % 2 == 0 else dark
                pygame.draw.rect(self.screen, color, (x, y, self.square_size, self.square_size))
                if self.ui_state.selected_square == square:
                    pygame.draw.rect(self.screen, highlight, (x, y, self.square_size, self.square_size), 4)
                if self.ui_state.last_move and square in (self.ui_state.last_move.from_square, self.ui_state.last_move.to_square):
                    pygame.draw.rect(self.screen, last_move_color, (x, y, self.square_size, self.square_size), 4)

    def draw_pieces(self, dt_ms: int = 16) -> None:
        for square, piece in self.game_state.board.piece_map().items():
            x, y = self.square_to_screen(square)
            anim = self.animations.get(square)
            if anim:
                x, y, done = anim.tick(dt_ms)
                if done:
                    self.animations.pop(square, None)
            piece_set = str(self.theme.get("pieces", "set", default="alpha")).lower()
            if piece_set == "unicode":
                glyph = PIECE_GLYPHS[piece.symbol()]
                color = pygame.Color("black") if piece.color else pygame.Color("white")
                self.screen.blit(self.piece_font.render(glyph, True, color), (x + 6, y + 2))
            else:
                img = self.piece_manager.get_image(piece.symbol(), self.square_size)
                self.screen.blit(img, (x, y))

    def draw_hud(self) -> None:
        bg = pygame.Color(self.theme.get("hud", "background", default="#1E1E1E"))
        fg = pygame.Color(self.theme.get("hud", "text", default="#F5F5F5"))
        accent = pygame.Color(self.theme.get("hud", "accent", default="#00BCD4"))
        muted = pygame.Color("#888888")
        pygame.draw.rect(self.screen, bg, self.hud_rect, border_radius=12)
        pygame.draw.rect(self.screen, accent, self.hud_rect, width=2, border_radius=12)

        pad = 12
        x = self.hud_rect.x + pad
        current_y = self.hud_rect.y + pad
        width = self.hud_rect.width - 2 * pad

        self.screen.blit(self.text_font.render("Aether Chess", True, accent), (x, current_y))
        current_y += self.text_font.get_height() + 4

        status = "Game Over" if self.game_state.board.is_game_over() else ("White to move" if self.game_state.board.turn else "Black to move")
        self.screen.blit(self.text_font.render(status, True, fg), (x, current_y))
        current_y += self.text_font.get_height() + 6

        info_font = pygame.font.SysFont("Arial", max(12, self.text_font.get_height() - 4))
        info_items = [
            f"Mode: {self.settings.game_mode.value.replace('_', ' ')}",
            f"Engine: {self.settings.engine_type.value}",
            f"Strength: {self.settings.ai_strength}/10",
            f"Opening: {self.settings.opening_strategy.value}",
            f"Books: {'auto' if self.settings.auto_rotate_books else f'fixed#{self.settings.active_book_index + 1}'}",
        ]
        for item in info_items:
            self.screen.blit(info_font.render(item, True, muted), (x, current_y))
            current_y += info_font.get_height() + 2
        current_y += 6

        cols = 2 if width >= MIN_TWO_COLUMN_BUTTON_WIDTH else 1
        gap = 6
        button_h = max(24, min(34, info_font.get_height() + 10))
        button_w = (width - gap * (cols - 1)) // cols
        self._ensure_hud_buttons(x, current_y, width, cols, button_w, button_h, gap)
        for button in self.hud_buttons:
            rect = button.rect
            pygame.draw.rect(self.screen, pygame.Color("#0f0f0f"), rect, border_radius=8)
            pygame.draw.rect(self.screen, accent, rect, width=1, border_radius=8)
            label_surface = info_font.render(button.label, True, fg)
            lx = rect.x + (rect.width - label_surface.get_width()) // 2
            ly = rect.y + (rect.height - label_surface.get_height()) // 2
            self.screen.blit(label_surface, (lx, ly))

        button_rows = (len(self.hud_buttons) + cols - 1) // cols
        current_y = current_y + button_rows * (button_h + gap) + 6

        status_line = self.engine_controller.last_error or self.engine_controller.status
        status_display = status_line if len(status_line) <= STATUS_MAX_LENGTH else f"{status_line[:STATUS_TRUNCATE_LENGTH]}..."
        self.screen.blit(info_font.render(status_display, True, accent), (x, current_y))
        current_y += info_font.get_height() + 6

        moves_h = max(70, self.hud_rect.bottom - current_y - pad)
        self.moves_rect = pygame.Rect(x, current_y, width, moves_h)
        pygame.draw.rect(self.screen, pygame.Color("#121212"), self.moves_rect, border_radius=8)

        moves = self.game_state.board.move_stack
        move_line_height = max(18, info_font.get_height() + 4)
        total_move_height = (len(moves) + 1) // 2 * move_line_height
        move_surface = pygame.Surface(
            (
                max(10, self.moves_rect.width - (MOVE_LIST_PADDING + MOVE_LIST_EXTRA_WIDTH)),
                max(self.moves_rect.height - MOVE_LIST_PADDING, total_move_height + MOVE_LIST_PADDING),
            )
        )
        move_surface.fill(pygame.Color("#121212"))
        my = 4
        for i in range(0, len(moves), 2):
            w = moves[i].uci()
            b = moves[i + 1].uci() if i + 1 < len(moves) else ""
            move_text = f"{i // 2 + 1:>2}. {w:<6} {b:<6}"
            move_surface.blit(info_font.render(move_text, True, fg), (4, my))
            my += move_line_height
        max_offset = max(0, move_surface.get_height() - self.moves_rect.height + MOVE_LIST_PADDING)
        self.ui_state.scroll_offset = min(self.ui_state.scroll_offset, max_offset)
        clip_rect = pygame.Rect(
            0, self.ui_state.scroll_offset, move_surface.get_width(), self.moves_rect.height - MOVE_LIST_PADDING
        )
        self.screen.blit(
            move_surface,
            (self.moves_rect.x + MOVE_LIST_PADDING // 2 + 1, self.moves_rect.y + MOVE_LIST_PADDING // 2),
            area=clip_rect,
        )

    def render(self, dt_ms: int = 16) -> None:
        self.screen.fill((12, 12, 12))
        self.draw_board()
        self.draw_pieces(dt_ms)
        self.draw_hud()
        pygame.display.flip()

    def save_screenshot(self, path: str) -> str:
        self.render(16)
        out = str(Path(path).resolve())
        pygame.image.save(self.screen, out)
        return out

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
        copied = self._copy_to_clipboard(fen)
        self.engine_controller.status = "FEN copied and exported" if copied else f"FEN exported: {out.name}"
        return str(out)

    def export_pgn(self) -> str:
        pgn = self.game_state.to_pgn()
        self.export_dir.mkdir(parents=True, exist_ok=True)
        out = self.export_dir / f"aether-game-{self._timestamp()}.pgn"
        out.write_text(pgn + "\n", encoding="utf-8")
        copied = self._copy_to_clipboard(pgn)
        self.engine_controller.status = "PGN copied and exported" if copied else f"PGN exported: {out.name}"
        return str(out)

    def export_screenshot(self) -> str:
        self.export_dir.mkdir(parents=True, exist_ok=True)
        out = self.export_dir / f"aether-board-{self._timestamp()}.png"
        path = self.save_screenshot(str(out))
        self.engine_controller.status = f"Image exported: {Path(path).name}"
        return path

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
                    elif event.button == 4 and self.moves_rect.collidepoint(*event.pos):
                        self.ui_state.scroll_offset = max(0, self.ui_state.scroll_offset - SCROLL_INCREMENT)
                    elif event.button == 5 and self.moves_rect.collidepoint(*event.pos):
                        self.ui_state.scroll_offset += SCROLL_INCREMENT
                elif event.type == pygame.VIDEORESIZE:
                    self.screen = pygame.display.set_mode((event.w, event.h), DISPLAY_FLAGS)
                    self._recompute_layout()
                elif event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_r:
                        self.ui_state.rotate = not self.ui_state.rotate
                    elif event.key == pygame.K_u:
                        if self.settings.game_mode == GameMode.HUMAN_VS_AI:
                            self.game_state.pop()
                            self.game_state.pop()
                        else:
                            self.game_state.pop()
                    elif event.key == pygame.K_m:
                        self.settings.cycle_mode()
                        self._sync_engine_settings()
                    elif event.key == pygame.K_e:
                        self.settings.cycle_engine_type()
                        self._sync_engine_settings()
                    elif event.key == pygame.K_s:
                        self.settings.bump_strength(1)
                        self._sync_engine_settings()
                    elif event.key == pygame.K_a:
                        self.settings.bump_strength(-1)
                        self._sync_engine_settings()
                    elif event.key == pygame.K_o:
                        self.settings.cycle_opening_strategy()
                        self._sync_engine_settings()
                    elif event.key == pygame.K_c:
                        self.settings.cycle_human_color()
                        self._sync_engine_settings()
                    elif event.key == pygame.K_b:
                        self.settings.cycle_book_mode()
                        self._sync_engine_settings()
                    elif event.key == pygame.K_n:
                        self.settings.cycle_active_book()
                        self._sync_engine_settings()
                    elif event.key == pygame.K_t:
                        self.settings.bump_threads(1)
                        self._sync_engine_settings()
                    elif event.key == pygame.K_g:
                        self.settings.bump_threads(-1)
                        self._sync_engine_settings()
                    elif event.key == pygame.K_y:
                        self.settings.bump_movetime(100)
                        self._sync_engine_settings()
                    elif event.key == pygame.K_h:
                        self.settings.bump_movetime(-100)
                        self._sync_engine_settings()
                    elif event.key == pygame.K_p:
                        self._cycle_uci_path()
                    elif event.key == pygame.K_f:
                        self.export_fen()
                    elif event.key == pygame.K_j:
                        self.export_pgn()
                    elif event.key == pygame.K_i:
                        self.export_screenshot()
                    self.start_engine_reply()
            self.render(dt)
        self.engine_controller.stop_uci()
        pygame.quit()
