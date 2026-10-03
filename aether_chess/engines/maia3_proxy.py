from __future__ import annotations

import concurrent.futures
import contextlib
import io
import os
import sys
from dataclasses import dataclass
from typing import Any, Optional

import chess
import chess.engine  # noqa: F401  (used via `chess.engine.*` below)


class Maia3UnavailableError(RuntimeError):
    pass


class _ThreadLocalCapture:
    """Capture only this thread's stdout/stderr (P2-T19, same class as P1-T02).

    The old `contextlib.redirect_stdout` rebound `sys.stdout` process-wide,
    so a concurrent request's JSON-RPC reply landed in this thread's throwaway
    buffer and the client hung. Instead this bumps the per-thread depth
    counters on the `ThreadLocalStream` proxies `backend/service.py:main()`
    installs: other threads keep depth 0 and write through to the real stream.

    No import of service.py here on purpose — service -> chess_engine ->
    maia3_proxy -> service would be an import cycle (verified: service.py
    imports chess_engine, backend/chess_engine.py:40 imports this module), so
    the proxy is duck-typed via its `_local` depth/buffer counters. A tiny
    documented duplication beats a cycle. With no proxies installed (unit
    tests, direct use) it falls back to redirect_stdout/redirect_stderr, which
    is safe single-threaded. The P2-T10 budget clamp below is untouched.
    """

    def __init__(self) -> None:
        self._locals: list[tuple[Any, Any, int]] = []
        self._fallback: contextlib.ExitStack | None = None

    def __enter__(self) -> _ThreadLocalCapture:
        for name in ("stdout", "stderr"):
            stream = getattr(sys, name)
            local = getattr(stream, "_local", None)
            if local is None:
                continue
            self._locals.append(
                (local, getattr(local, "buffer", None), getattr(local, "depth", 0))
            )
            local.buffer = io.StringIO()
            local.depth = getattr(local, "depth", 0) + 1
        if not self._locals:
            stack = contextlib.ExitStack()
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            self._fallback = stack
        return self

    # Returns None (never suppresses): an in-body exception must propagate
    # to the caller, and it lets type checkers see try-body bindings below.
    def __exit__(self, *exc_info: Any) -> None:
        for local, prev_buffer, prev_depth in reversed(self._locals):
            local.buffer = prev_buffer
            local.depth = prev_depth
        self._locals = []
        if self._fallback is not None:
            self._fallback.close()
            self._fallback = None


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

    def __init__(self, ping_timeout: float = 300.0) -> None:
        self._engine = None
        self._engine_key: Optional[tuple] = None
        self._ping_timeout = ping_timeout
        self._ping_pool = self._new_ping_pool()

    @staticmethod
    def _new_ping_pool() -> concurrent.futures.ThreadPoolExecutor:
        # One persistent worker: ping is rare and serial, so a pool of one
        # bounds thread use without a per-call executor whose __exit__ would
        # join (and hang) on a stuck ping.
        return concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="maia3-ping"
        )

    def _ping_with_timeout(self, engine) -> None:
        """Ping the engine, raising if it does not answer within ping_timeout.

        Runs on the persistent pool so a hung ping raises on time instead of
        hanging the caller: the old per-call ``with ThreadPoolExecutor`` joined
        on exit and blocked regardless of the future timeout. On failure the
        worker is abandoned without waiting and replaced, so the proxy stays
        reusable and no thread accumulates per retry.
        """
        future = self._ping_pool.submit(engine.ping)
        try:
            future.result(timeout=self._ping_timeout)
        except Exception:
            # Never wait for the stuck worker — waiting is exactly what made
            # the old hang-guard useless. The hung thread exits on its own (it
            # is a ping, not a join), so thread count stays flat across
            # retries while the next ping gets a fresh worker.
            self._ping_pool.shutdown(wait=False, cancel_futures=True)
            self._ping_pool = self._new_ping_pool()
            raise

    def is_available(self, maia3_path: Optional[str] = None) -> bool:
        """Cheap check that Maia3 *could* run. Never loads the model.

        Starting the engine can take minutes because it loads weights, so this
        only verifies the cheap preconditions: torch and the maia3 package
        import, and any explicit path exists. It does not prove inference will
        succeed -- that is what Maia3UnavailableError from play() is for.
        """
        if maia3_path and not os.path.exists(maia3_path):
            return False
        try:
            import torch  # noqa: F401
        except Exception:
            return False
        try:
            import maia3  # noqa: F401
        except Exception:
            return False
        return True

    def close(self) -> None:
        """Release the UCI subprocess. Safe to call more than once."""
        if self._engine is not None:
            try:
                self._engine.quit()
            except Exception:
                pass
            self._engine = None
            self._engine_key = None
        # Never block shutdown on a stuck ping worker: abandon without
        # waiting, then hand any future use a fresh pool.
        try:
            self._ping_pool.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass
        self._ping_pool = self._new_ping_pool()

    def _ensure_engine(self, req: Maia3Request):
        key = (
            req.model,
            req.device,
            req.maia3_path,
            req.cache_dir,
            req.temperature,
            req.top_p,
            req.elo,
        )
        if self._engine is not None:
            if self._engine_key == key:
                return self._engine

        self.close()

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
            # Use the persistent pool with a timeout so a hanging model
            # download raises instead of freezing the backend forever.
            # Failure here means a clear error instead of a silent crash
            # during play().
            self._ping_with_timeout(self._engine)
            self._engine_key = key
            return self._engine
        except Exception as exc:
            import traceback

            tb = traceback.format_exc()
            print(
                f"[DEBUG maia3_proxy] _ensure_engine error: type={type(exc).__name__}, msg=[{exc}]",
                file=sys.stderr,
            )
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
        time_limit_sec: float | None = None,
    ) -> dict:
        # Late import: aether_chess.bots.maia3_bot imports this module, so a
        # top-level import would cycle back through aether_chess.bots/__init__.
        from aether_chess.bots.base import clamp_time_limit

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
        # Single budget source: the manager resolves one aligned budget per
        # move (resolve_budget -> request.time_limit_sec) and the bot forwards
        # it here. Drive Limit from that budget directly -- never re-sample
        # the profile here: min(sampled, budget) double-discounts whenever
        # the second roll lands lower (P2-T23 measured 3.23 -> 1.05).
        # think_profile / time_remaining / time_increment stay in the
        # signature (forwarded clock context; callers pass them by keyword)
        # but no longer shape the limit. The clamp stays.
        budget = clamp_time_limit(time_limit_sec)
        limit = chess.engine.Limit(time=budget)

        try:
            with _ThreadLocalCapture():
                result = engine.play(board, limit)
        except Exception as exc:
            import traceback

            tb = traceback.format_exc()
            print(
                f"[DEBUG maia3_proxy] play() exception: type={type(exc).__name__}, msg=[{exc}]",
                file=sys.stderr,
            )
            print(f"[DEBUG maia3_proxy] Traceback:\n{tb}", file=sys.stderr)
            msg = str(exc)
            if "c10.dll" in msg or "torch" in msg:
                raise Maia3UnavailableError(
                    f"Maia3 failed to start (torch DLL error). Reinstall CPU-only torch in the venv. [{exc}]"
                ) from exc
            raise Maia3UnavailableError(f"[{type(exc).__name__}] {exc}") from exc

        if result and result.move:
            san = board.san(result.move)
            return {"move": result.move.uci(), "san": san}
        return {"move": None, "san": None}
