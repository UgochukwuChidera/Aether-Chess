"""
C++ accelerated chess evaluation module for AetherChess.

This module wraps the compiled C++ evaluation engine. If the C++ module
is not available (not compiled yet), it falls back to pure Python evaluation.

Compile with:
    python setup.py build_ext --inplace

Or on Windows (MSVC):
    build_msvc.bat
"""

import glob
import importlib.util
import os

_HERE = os.path.dirname(__file__)


def _load_native_module(path):
    """Load the compiled kernel from ``path`` and return its functions.

    The spec name MUST be the extension's real module name
    (``cpp_engine``): CPython derives the init symbol from it
    (``PyInit_cpp_engine``), so an alias name fails with
    ``ImportError: dynamic module does not define module export
    function`` (found live in P4-T06 -- the alias this wrapper
    originally used never matched any built ``.so``).

    The true name collides with this wrapper package in
    ``sys.modules``: for a single-phase extension module,
    ``module_from_spec`` (via ``_imp.create_dynamic``) registers the
    fresh native module under ``sys.modules['cpp_engine']``,
    evicting the wrapper (proven by bisect in P4-T06 -- the entry
    flips at ``module_from_spec``, before ``exec_module``). So save
    and restore the entry around the load; the native handle itself
    is returned directly and never re-registered.
    """
    import sys

    saved = sys.modules.get("cpp_engine")
    spec = importlib.util.spec_from_file_location("cpp_engine", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load native module from {path}")
    module = None
    try:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        # Whatever exec does (success or raise), put the wrapper back:
        # the caller keeps working with the restored package, and the
        # native functions travel on the returned handle, not sys.modules.
        if saved is not None:
            sys.modules["cpp_engine"] = saved
        else:
            sys.modules.pop("cpp_engine", None)
    return module.evaluate, getattr(module, "evaluate_batch", None)


def _try_import_cpp(loader=None):
    """Try to import the compiled C++ module.

    ``loader`` is an injectable zero-arg callable returning an
    ``(evaluate, evaluate_batch)`` pair (P4-T03 Tier 2: tests inject a
    fake; production never passes one). ``None`` (default) keeps the
    historical behaviour: try a top-level ``cpp_engine`` import, then an
    in-place library beside this file (exact names first, then
    ABI-tagged ``cpp_engine.*.so`` / ``.pyd`` as produced by
    ``setup.py build_ext --inplace``). Any failure yields ``(None, None)``
    and the caller falls back to pure Python.
    """
    if loader is not None:
        try:
            return loader()
        except Exception:
            return None, None
    try:
        # Try direct import first (works when the extension is installed
        # as a top-level module, e.g. on sys.path as cpp_engine/ build dir).
        from cpp_engine import evaluate, evaluate_batch

        # When this wrapper package is what ``cpp_engine`` resolves to,
        # the names above are absent and this raises ImportError -- which
        # is the signal to try the file-loading branches below. (A stale
        # circular self-import cannot return the native functions because
        # this module never defines them.)
        if callable(evaluate):
            return evaluate, evaluate_batch
    except ImportError:
        pass

    # Try loading from this directory: exact legacy names first ...
    for ext in [".pyd", ".dll", ".so"]:
        path = os.path.join(_HERE, f"cpp_engine{ext}")
        if os.path.exists(path):
            try:
                return _load_native_module(path)
            except Exception:
                pass

    # ... then ABI-tagged builds (what setuptools actually emits:
    # cpp_engine.cpython-314-x86_64-linux-gnu.so).
    for path in sorted(glob.glob(os.path.join(_HERE, "cpp_engine.*.so"))):
        try:
            return _load_native_module(path)
        except Exception:
            continue
    for path in sorted(glob.glob(os.path.join(_HERE, "cpp_engine.*.pyd"))):
        try:
            return _load_native_module(path)
        except Exception:
            continue

    return None, None


# Try to load C++ module
_evaluate_cpp, _evaluate_batch_cpp = _try_import_cpp()
_has_cpp = _evaluate_cpp is not None


def get_info() -> str:
    """Return whether C++ acceleration is active."""
    if _has_cpp:
        return "C++ accelerated evaluation ACTIVE"
    return "C++ evaluation NOT AVAILABLE (compile with: python setup.py build_ext --inplace)"


def _validate_fen(fen: str) -> None:
    """Reject FEN the C++ kernel would silently score 0 (P4-T03 Change 1).

    ``BoardState::parse_fen`` returns false -- historically read as ``0``,
    indistinguishable from a dead-even position -- on garbage input and on
    kingless positions. The caller already has python-chess, so validate
    here, once, for BOTH branches: ``chess.Board`` raises ``ValueError``
    on syntactically bad FEN, and both kings are required to mirror the
    kernel's own ``king_sq < 0 -> false`` rule. Raises ``ValueError``.
    """
    import chess

    board = chess.Board(fen)  # raises ValueError on malformed FEN
    if board.king(chess.WHITE) is None or board.king(chess.BLACK) is None:
        raise ValueError(f"FEN has no legal position (missing king): {fen!r}")


def evaluate_fen(fen: str) -> int:
    """Evaluate a FEN position. Uses C++ if available."""
    _validate_fen(fen)
    if _has_cpp:
        return _evaluate_cpp(fen)
    # Pure Python fallback
    import chess

    board = chess.Board(fen)
    from aether_chess.engines.mentor_engine import MentorEngine

    eng = MentorEngine()
    return eng.evaluate(board)


def evaluate_batch(fens: list) -> list:
    """Evaluate multiple FEN positions in batch."""
    for fen in fens:
        _validate_fen(fen)
    if _evaluate_batch_cpp:
        return _evaluate_batch_cpp(fens)
    return [evaluate_fen(f) for f in fens]
