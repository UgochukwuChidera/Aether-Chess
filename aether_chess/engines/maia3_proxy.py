from __future__ import annotations

import contextlib
import io
import os
import sys
import time
from dataclasses import dataclass
from typing import Optional

import chess

from aether_chess.think_profile import get_profile, sample_think_time


class Maia3UnavailableError(RuntimeError):
    pass


@dataclass
class Maia3Request:
    fen: str
    model: str
    device: str
    maia3_path: Optional[str]
    cache_dir: Optional[str]
    temperature: float
    top_p: float
    elo: int
    think_profile: str
    time_remaining: Optional[float]
    time_increment: Optional[float]


class Maia3Proxy:
    """Run Maia3 inference while suppressing stdout noise."""

    def __init__(self) -> None:
        self._engine = None
        self._engine_key: Optional[tuple] = None

    def _ensure_engine(self, req: Maia3Request):
        key = (
            req.model, req.device, req.maia3_path, req.cache_dir,
            req.temperature, req.top_p, req.elo,
        )
        if self._engine is not None:
            if self._engine_key == key:
                return self._engine

        if self._engine is not None:
            try:
                self._engine.quit()
            except Exception:
                pass
            self._engine = None

        try:
            try:
                import torch
                _ = torch.empty(1)
            except Exception as exc:
                raise Maia3UnavailableError(
                    f"PyTorch failed to load (missing DLLs). Reinstall CPU-only torch in the venv. [{exc}]"
                ) from exc

            try:
                import maia3  # noqa: F401
            except Exception as exc:
                raise Maia3UnavailableError(
                    f"Maia3 is not installed. Run: python -m pip install -e .\\inspiration [{exc}]"
                ) from exc

            import chess.engine
            if req.maia3_path:
                cmd = [req.maia3_path]
            else:
                cmd = [sys.executable, "-m", "maia3.uci"]
            cmd += ["--model", req.model, "--device", req.device]
            if req.cache_dir:
                cmd += ["--cache-dir", req.cache_dir]
            cmd += ["--temperature", str(req.temperature), "--top-p", str(req.top_p)]
            cmd += ["--elo", str(req.elo)]
            self._engine = chess.engine.SimpleEngine.popen_uci(cmd, timeout=120)
            # Force model loading now (sends isready, engine loads model).
            # Use a thread with timeout so a hanging model download doesn't
            # freeze the backend forever. Failure here means a clear error
            # instead of a silent crash during play().
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                fut = pool.submit(self._engine.ping)
                fut.result(timeout=300.0)
            self._engine_key = key
            return self._engine
        except Exception as exc:
            import traceback
            tb = traceback.format_exc()
            print(f"[DEBUG maia3_proxy] _ensure_engine error: type={type(exc).__name__}, msg=[{exc}]", file=sys.stderr)
            print(f"[DEBUG maia3_proxy] Traceback:\n{tb}", file=sys.stderr)
            raise Maia3UnavailableError(f"[{type(exc).__name__}] {exc}") from exc

    def play(
        self,
        fen: str,
        model: str = "maia3-5m",
        device: str = "cpu",
        maia3_path: Optional[str] = None,
        cache_dir: Optional[str] = None,
        temperature: float | None = None,
        top_p: float = 1.0,
        elo: int = 1500,
        think_profile: str = "human_like",
        time_remaining: float | None = None,
        time_increment: float | None = None,
    ) -> dict:
        if temperature is None:
            if elo >= 2200:
                temperature = 0.0
            elif elo >= 1800:
                temperature = 0.2
            elif elo >= 1500:
                temperature = 0.4
            elif elo >= 1200:
                temperature = 0.7
            elif elo >= 800:
                temperature = 1.0
            else:
                temperature = 1.2

        req = Maia3Request(
            fen=fen,
            model=model,
            device=device,
            maia3_path=maia3_path,
            cache_dir=cache_dir,
            temperature=temperature,
            top_p=top_p,
            elo=elo,
            think_profile=think_profile,
            time_remaining=time_remaining,
            time_increment=time_increment,
        )
        engine = self._ensure_engine(req)
        board = chess.Board(fen)
        limit = chess.engine.Limit(time=0.1)

        t0 = time.perf_counter()
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                result = engine.play(board, limit)
        except Exception as exc:
            import traceback
            tb = traceback.format_exc()
            print(f"[DEBUG maia3_proxy] play() exception: type={type(exc).__name__}, msg=[{exc}]", file=sys.stderr)
            print(f"[DEBUG maia3_proxy] Traceback:\n{tb}", file=sys.stderr)
            msg = str(exc)
            if "c10.dll" in msg or "torch" in msg:
                raise Maia3UnavailableError(
                    f"Maia3 failed to start (torch DLL error). Reinstall CPU-only torch in the venv. [{exc}]"
                ) from exc
            raise Maia3UnavailableError(f"[{type(exc).__name__}] {exc}") from exc
        elapsed = time.perf_counter() - t0

        target = sample_think_time(
            get_profile(think_profile),
            board=board,
            time_remaining=time_remaining,
            time_increment=time_increment,
        )
        remaining = target - elapsed
        if remaining > 0:
            time.sleep(remaining)

        if result and result.move:
            san = board.san(result.move)
            return {"move": result.move.uci(), "san": san}
        return {"move": None, "san": None}
