from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, Optional

import pygame


class PieceSet:
    """Manages a set of chess piece images."""

    def __init__(self, name: str, asset_dir: str = "aether_chess/assets/pieces"):
        self.name = name
        self.base_path = Path(asset_dir) / name
        self.images: Dict[str, pygame.Surface] = {}
        self.scaled_cache: Dict[tuple[str, int], pygame.Surface] = {}
        self._load_images()

    def _load_images(self) -> None:
        # Mapping from python-chess symbols to filenames
        # Symbols: P, N, B, R, Q, K (White) | p, n, b, r, q, k (Black)
        mapping = {
            "P": "plt", "N": "nlt", "B": "blt", "R": "rlt", "Q": "qlt", "K": "klt",
            "p": "pdt", "n": "ndt", "b": "bdt", "r": "rdt", "q": "qdt", "k": "kdt"
        }

        for symbol, suffix in mapping.items():
            filename = f"Chess_{suffix}60.png"
            path = self.base_path / filename
            if path.exists():
                try:
                    self.images[symbol] = pygame.image.load(str(path)).convert_alpha()
                except pygame.error as e:
                    print(f"Error loading piece {symbol} from {path}: {e}")
            else:
                print(f"Warning: Piece image not found: {path}")

    def get_piece_image(self, symbol: str, size: int) -> pygame.Surface:
        """Returns a scaled piece image for the given symbol."""
        cache_key = (symbol, size)
        if cache_key in self.scaled_cache:
            return self.scaled_cache[cache_key]

        img = self.images.get(symbol)
        if img:
            scaled = pygame.transform.smoothscale(img, (size, size))
            self.scaled_cache[cache_key] = scaled
            return scaled
        
        # Fallback to a placeholder if image is missing
        surface = pygame.Surface((size, size), pygame.SRCALPHA)
        pygame.draw.circle(surface, (255, 0, 0), (size // 2, size // 2), size // 2)
        return surface


class PieceManager:
    """Manages multiple piece sets and handles interchangeability."""

    def __init__(self, asset_dir: str = "aether_chess/assets/pieces"):
        self.asset_dir = asset_dir
        self.sets: Dict[str, PieceSet] = {}
        self.current_set_name: Optional[str] = None

    def get_set(self, name: str) -> PieceSet:
        if name not in self.sets:
            self.sets[name] = PieceSet(name, self.asset_dir)
        return self.sets[name]

    def set_current(self, name: str) -> None:
        self.current_set_name = name

    def get_image(self, symbol: str, size: int) -> pygame.Surface:
        if not self.current_set_name:
            # Fallback to a basic set if none selected
            self.current_set_name = "alpha"
        
        return self.get_set(self.current_set_name).get_piece_image(symbol, size)
