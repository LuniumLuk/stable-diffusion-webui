@echo off
REM ============================================================
REM  cut_grid.bat -- cut an image into a cols x rows grid by hand
REM  Runs gemini_workflow\cut_grid.py on the workflow venv.
REM ============================================================
REM
REM GUI (default): drag the red divider lines onto the real panel
REM borders, then click Export. Cells are saved into --out.
REM   cut_grid.bat --image .\tmp\sheet.png --cols 3 --rows 4 --out .\tmp\tiles
REM   cut_grid.bat --image .\tmp\sheet.png --cols 3 --rows 4   (uses the
REM       file's own folder + "_cut" suffix, opens dialog if no --image)
REM
REM Headless even cut (no window):
REM   cut_grid.bat --image .\tmp\sheet.png --cols 3 --rows 4 --out .\tmp\tiles --nogui --trim 8
REM
REM Tiles: <stem>_r01c01.png ... <stem>_r04c03.png
REM ============================================================

setlocal

set SCRIPT_DIR=%~dp0
set WORKFLOW_PYTHON=%SCRIPT_DIR%gemini_workflow\venv\Scripts\python.exe
set WORKFLOW=%SCRIPT_DIR%gemini_workflow\cut_grid.py

"%WORKFLOW_PYTHON%" "%WORKFLOW%" %*

endlocal & exit /b %errorlevel%
