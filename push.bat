@echo off
REM ============================================================
REM  BSC Tickets - save locally + push to GitHub in one step
REM  Usage:  double-click, or  push.bat "your commit message"
REM ============================================================
cd /d "%~dp0"

REM First run: initialise the repo and point it at GitHub
IF NOT EXIST ".git" (
  echo Initialising git repository...
  git init
  git branch -M main
  git remote add origin https://github.com/BSC23609/bsc-tickets.git
)

REM Make sure the remote is correct even on later runs
git remote set-url origin https://github.com/BSC23609/bsc-tickets.git 2>nul

echo Staging changes...
git add -A

REM Commit message = argument if given, else timestamp
SET "MSG=%~1"
IF "%MSG%"=="" SET "MSG=Update %DATE% %TIME%"

git commit -m "%MSG%"
IF ERRORLEVEL 1 echo (Nothing new to commit - pushing anyway in case of pending commits)

echo Pushing to GitHub...
git push -u origin main

echo.
echo ===== Done =====
pause
