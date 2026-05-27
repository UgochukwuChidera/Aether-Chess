"""
Build script for C++ accelerated chess evaluation.

Usage: python setup.py build_ext --inplace
Or:    build_msvc.bat
"""
import os
import sys
import sysconfig
from setuptools import setup, Extension

python_include = sysconfig.get_path('include')

cpp_engine = Extension(
    'cpp_engine',
    sources=[
        'pymodule.c',
        'evaluate.cpp',
    ],
    include_dirs=[python_include, '.'],
    language='c++',
    extra_compile_args=['/O2', '/EHsc', '/std:c++17'] if sys.platform == 'win32' else ['-O3', '-std=c++17', '-march=native'],
)

setup(
    name='cpp_engine',
    version='1.0',
    ext_modules=[cpp_engine],
)
