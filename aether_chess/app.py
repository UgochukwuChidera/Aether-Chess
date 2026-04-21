from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Tuple

import chess
import pygame

from aether_chess.engines.mentor_engine import MentorEngine
from aether_chess.models.game_state import GameState
from aether_chess.ui.animation import PieceAnimation
from aether_chess.ui.theme import ThemeManager

PIECE_GLYPHS = {
    "P": "♙", "N": "♘", "B": "♗", "R": "♖", "Q": "♕", "K": "♔",
    "p": "♟", "n": "♞", "b": "♝", "r": "♜", "q": "♛", "k": "♚",
}


@dataclass
class UIState:
    selected_square: Optional[int] = None
    last_move: Optional[chess.Move] = None
    rotate: bool = False


class AetherChessApp:
    def __init__(self, width: int = 960, height: int = 720):
        pygame.init()
        pygame.font.init()
        self.screen = pygame.display.set_mode((width, height))
        pygame.display.set_caption("Aether Chess")
        self.clock = pygame.time.Clock()

        self.game_state = GameState()
        self.ui_state = UIState()
        self.theme_manager = ThemeManager("aether_chess/config/default_theme.json")
        self.theme = self.theme_manager.theme

        self.square_size = min(height - 40, 640) // 8
        self.board_origin = (20, 20)
        self.hud_x = self.board_origin[0] + self.square_size * 8 + 20

        self.piece_font = pygame.font.SysFont("DejaVu Sans,Segoe UI Symbol,Arial Unicode MS", self.square_size - 8)
        self.text_font = pygame.font.SysFont("Arial", 20)

        self.animations: Dict[int, PieceAnimation] = {}
        self.running = True

        self.mentor_engine = MentorEngine()
        self.engine_thread: Optional[threading.Thread] = None
        self.pending_engine_move: Optional[chess.Move] = None

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
        if self.game_state.board.is_game_over() or (self.engine_thread and self.engine_thread.is_alive()):
            return

        def worker() -> None:
            self.pending_engine_move = self.mentor_engine.search(self.game_state.board.copy(stack=False))

        self.engine_thread = threading.Thread(target=worker, daemon=True)
        self.engine_thread.start()

    def apply_engine_reply_if_ready(self) -> None:
        if self.pending_engine_move and self.pending_engine_move in self.game_state.board.legal_moves:
            self._push_with_animation(self.pending_engine_move)
        self.pending_engine_move = None

    def handle_click(self, x: int, y: int) -> None:
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
            glyph = PIECE_GLYPHS[piece.symbol()] if piece_set == "unicode" else piece.symbol()
            color = pygame.Color("black") if piece.color else pygame.Color("white")
            self.screen.blit(self.piece_font.render(glyph, True, color), (x + 6, y + 2))

    def draw_hud(self) -> None:
        bg = pygame.Color(self.theme.get("hud", "background", default="#1E1E1E"))
        fg = pygame.Color(self.theme.get("hud", "text", default="#F5F5F5"))
        accent = pygame.Color(self.theme.get("hud", "accent", default="#00BCD4"))
        pygame.draw.rect(self.screen, bg, (self.hud_x, 20, 260, 640), border_radius=8)
        self.screen.blit(self.text_font.render("Aether Chess", True, fg), (self.hud_x + 16, 36))

        status = "Game Over" if self.game_state.board.is_game_over() else ("White to move" if self.game_state.board.turn else "Black to move")
        self.screen.blit(self.text_font.render(status, True, accent), (self.hud_x + 16, 72))

        y = 120
        moves = self.game_state.board.move_stack
        for i in range(0, len(moves), 2):
            w = moves[i].uci()
            b = moves[i + 1].uci() if i + 1 < len(moves) else ""
            self.screen.blit(self.text_font.render(f"{i // 2 + 1:>2}. {w:<6} {b:<6}", True, fg), (self.hud_x + 16, y))
            y += 24
            if y > 620:
                break
        self.screen.blit(self.text_font.render("R: rotate | U: undo", True, fg), (self.hud_x + 16, 628))

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

    def run(self) -> None:
        while self.running:
            dt = self.clock.tick(60)
            self.apply_engine_reply_if_ready()
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    self.running = False
                elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                    self.handle_click(*event.pos)
                elif event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_r:
                        self.ui_state.rotate = not self.ui_state.rotate
                    elif event.key == pygame.K_u:
                        self.game_state.pop()
                        self.game_state.pop()
            self.render(dt)
        pygame.quit()
