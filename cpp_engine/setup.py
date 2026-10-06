"""
Build script for C++ accelerated chess evaluation.

Usage (from repo root): python cpp_engine/setup.py build_ext --inplace
Or (from cpp_engine/):  python setup.py build_ext --inplace
Or:    npm run build:cpp
Or on Windows (MSVC):    build_msvc.bat

NOTE (P4-T03 Tier 0, 2026-10-06): the gcc build is BLOCKED past the
evaluate.h portability shim -- evaluate.cpp compiles warning-free under
-Wall -Wextra, but pymodule.c is compiled as C while including the C++
header evaluate.h (<cstdint>: No such file). Unblocks when the wrapper
TU is built as C++ (e.g. rename to .cpp); until then this script fails
at pymodule.c and the backend stays on the pure-Python fallback.
"""

import os
import sys
import sysconfig

from setuptools import Extension, setup

# P4-T03 Change 2: anchor to this file so the script works from the repo
# root (npm run build:cpp) as well as from cpp_engine/.
HERE = os.path.dirname(os.path.abspath(__file__))

python_include = sysconfig.get_path("include")

cpp_engine = Extension(
    "cpp_engine",
    sources=[
        os.path.join(HERE, "pymodule.c"),
        os.path.join(HERE, "evaluate.cpp"),
    ],
    include_dirs=[python_include, HERE],
    language="c++",
    extra_compile_args=(
        ["/O2", "/EHsc", "/std:c++17"]
        if sys.platform == "win32"
        else ["-O3", "-std=c++17", "-march=native", "-Wall", "-Wextra"]
    ),
)

setup(
    name="cpp_engine",
    version="1.0",
    ext_modules=[cpp_engine],
)
