"""
Build script for C++ accelerated chess evaluation.

Usage (from repo root): npm run build:cpp  (cds into cpp_engine/ first --
a top-level Extension name means --inplace emits beside THIS file only
when setup.py runs with cpp_engine/ as the CWD; invoking
``python cpp_engine/setup.py`` from the root misplaces the .so at the
root, where the loader never looks)
Or (from cpp_engine/):  python setup.py build_ext --inplace
Or on Windows (MSVC):    build_msvc.bat

NOTE (P4-T06, 2026-10-06): the wrapper TU is built as C++ (``pymodule.cpp``;
renamed from ``pymodule.c`` because it includes the C++ header
``evaluate.h`` -- ``<cstdint>`` has no C spelling). ``cl`` and ``g++``
both select C++ by the ``.cpp`` extension, so no flag changes were
needed on either branch.
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
        os.path.join(HERE, "pymodule.cpp"),
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
