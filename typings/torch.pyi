# Optional dependency: only required by the Maia neural-net path, which is off by
# default. The ONNX runtime is what the app actually uses, so torch is never
# installed here and must not be reported as a missing import.
from typing import Any

def __getattr__(name: str) -> Any: ...
