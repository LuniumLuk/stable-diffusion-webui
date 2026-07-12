@echo off
REM ============================================================
REM  Dataset Balance Launcher
REM  Runs kohya_ss/balance_dataset.py using the root .venv Python
REM ============================================================
REM
REM USAGE:
REM   balance_dataset.bat <dataset_root> [options]
REM
REM   All arguments are forwarded to balance_dataset.py.
REM   Run with --help for the full option list:
REM     balance_dataset.bat --help
REM
REM QUICK EXAMPLES:
REM   balance_dataset.bat data\characters --dry-run
REM   balance_dataset.bat data\characters
REM   balance_dataset.bat data\characters --target 35 --range 25 45
REM
REM NOTES:
REM   - Always run with --dry-run first to preview changes.
REM   - Repeat × image_count is balanced to ~40 (range 30–50 by default).
REM   - Subfolders without a numeric prefix get one added.
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set VENV_PYTHON=%SCRIPT_DIR%.venv\Scripts\python.exe
set BALANCE_SCRIPT=%SCRIPT_DIR%kohya_ss\balance_dataset.py

REM --- Check prerequisites ---
if not exist "%BALANCE_SCRIPT%" (
    echo ERROR: balance_dataset.py not found at: %BALANCE_SCRIPT%
    exit /b 1
)
if not exist "%VENV_PYTHON%" (
    echo ERROR: .venv Python not found at: %VENV_PYTHON%
    exit /b 1
)

REM --- Forward all arguments ---
"%VENV_PYTHON%" "%BALANCE_SCRIPT%" %*

exit /b %ERRORLEVEL%
