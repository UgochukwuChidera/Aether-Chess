@echo off
REM ============================================================
REM Build the C++ chess evaluation module for AetherChess
REM Requires: Visual Studio 2022 Build Tools or MSVC compiler
REM ============================================================

echo ============================================================
echo AetherChess C++ Engine Builder
echo ============================================================
echo.

REM Check if cl.exe is available
where cl.exe >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] cl.exe not found. Installing MSVC Build Tools...
    echo.
    echo Option 1: Install via Visual Studio Installer
    echo   Download from: https://visualstudio.microsoft.com/downloads/
    echo   Select "Desktop development with C++" workload
    echo.
    echo Option 2: Install via winget
    echo   winget install Microsoft.VisualStudio.2022.BuildTools
    echo.
    echo Option 3: Install MinGW-w64 (lighter ~500MB)
    echo   winget install Mingw-w64
    echo.
    echo After installing, run this script again from a "Developer Command Prompt"
    echo or run: "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    echo.
    
    REM Check if we can auto-install
    choice /M "Try to install MSVC Build Tools via winget? (Y/N)"
    if errorlevel 2 exit /b 1
    
    echo Installing Microsoft Visual Studio 2022 Build Tools...
    winget install Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements
    
    REM Try to find vcvars
    if exist "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" (
        call "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    ) else (
        echo [ERROR] Could not find MSVC compiler after installation.
        echo Please open "Visual Studio Installer", modify Build Tools,
        echo and ensure "MSVC v143 - VS 2022 C++ x64/x86 build tools" is selected.
        exit /b 1
    )
)

echo [OK] Found MSVC compiler.
echo.

REM Get Python include path
for /f %%i in ('python -c "import sysconfig; print(sysconfig.get_path('include'))"') do set PYTHON_INCLUDE=%%i
echo Python include: %PYTHON_INCLUDE%

REM Navigate to cpp_engine directory
cd /d "%~dp0"

echo.
echo Compiling C++ engine...
echo.

cl /nologo /O2 /EHsc /std:c++17 /LD ^
    /I"%PYTHON_INCLUDE%" ^
    pymodule.c evaluate.cpp ^
    /Fe:cpp_engine.pyd ^
    /link /OUT:cpp_engine.pyd

if %ERRORLEVEL% equ 0 (
    echo.
    echo ============================================================
    echo [SUCCESS] C++ engine compiled: cpp_engine.pyd
    echo ============================================================
    dir cpp_engine.pyd 2>nul
) else (
    echo.
    echo [ERROR] Compilation failed with error code %ERRORLEVEL%
    echo.
    echo Common fixes:
    echo 1. Run from "Developer Command Prompt for VS 2022"
    echo 2. Ensure Python 3.13 SDK is installed
    echo 3. Check that %PYTHON_INCLUDE% exists
    exit /b 1
)
