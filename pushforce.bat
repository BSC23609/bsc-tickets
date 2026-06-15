@echo off
REM  Use ONLY if push.bat reported "rejected / non-fast-forward".
REM  This overwrites the GitHub copy of main with YOUR local copy.
setlocal
cd /d "%~dp0"
IF NOT EXIST ".git" ( echo No .git here. & pause & exit /b 1 )
git remote set-url origin https://github.com/BSC23609/bsc-tickets.git 2>nul
git add -A
SET "MSG=%~1"
IF "%MSG%"=="" SET "MSG=Force update %DATE% %TIME%"
git commit -m "%MSG%" 2>nul
echo.
echo About to FORCE-push and overwrite remote main with your local files.
pause
git push -u origin main --force-with-lease
IF ERRORLEVEL 1 ( echo. & echo [X] Force push failed - read above. ) ELSE ( echo. & echo ===== Force-pushed OK ===== )
echo.
pause
