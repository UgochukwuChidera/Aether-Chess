"""
C++ accelerated chess evaluation module for AetherChess.

This module wraps the compiled C++ evaluation engine. If the C++ module 
is not available (not compiled yet), it falls back to pure Python evaluation.

Compile with:
    python setup.py build_ext --inplace

Or on Windows (MSVC):
    build_msvc.bat
"""

import os
import sys
import importlib.util

_HERE = os.path.dirname(__file__)

def _try_import_cpp():
    """Try to import the compiled C++ module."""
    try:
        # Try direct import first (works when compiled in-place)
        from cpp_engine import evaluate, evaluate_batch
        return evaluate, evaluate_batch
    except ImportError:
        pass
    
    # Try loading from this directory
    spec = None
    for ext in ['.pyd', '.dll', '.so']:
        path = os.path.join(_HERE, f'cpp_engine{ext}')
        if os.path.exists(path):
            spec = importlib.util.spec_from_file_location('cpp_engine', path)
            break
    
    if spec:
        try:
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module.evaluate, getattr(module, 'evaluate_batch', None)
        except Exception:
            pass
    
    return None, None

# Try to load C++ module
_evaluate_cpp, _evaluate_batch_cpp = _try_import_cpp()
_has_cpp = _evaluate_cpp is not None


def get_info() -> str:
    """Return whether C++ acceleration is active."""
    if _has_cpp:
        return "C++ accelerated evaluation ACTIVE"
    return "C++ evaluation NOT AVAILABLE (compile with: python setup.py build_ext --inplace)"


def evaluate_fen(fen: str) -> int:
    """Evaluate a FEN position. Uses C++ if available."""
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
    if _evaluate_batch_cpp:
        return _evaluate_batch_cpp(fens)
    return [evaluate_fen(f) for f in fens]
