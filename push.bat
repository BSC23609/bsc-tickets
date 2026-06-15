@echo off
setlocal
cd /d "%~dp0"
echo Repo folder: %CD%
echo.

IF NOT EXIST ".git" (
  echo [X] No .git in THIS folder - it is not the git repo.
  echo     push.bat must sit in your bsc-tickets repo root, next to package.json.
  echo.
  pause
  exit /b 1
)

git remote set-url origin https://github.com/BSC23609/bsc-tickets.git 2>nul

echo === Changes git can see ===
git status --short
echo ----------------------------
echo.

echo Staging...
git add -A

SET "MSG=%~1"
IF "%MSG%"=="" SET "MSG=Update %DATE% %TIME%"

git commit -m "%MSG%"
IF ERRORLEVEL 1 (
  echo.
  echo [i] Nothing new to commit. The updated files were probably not copied
  echo     into THIS folder ^(check the list above is empty^), or this version
  echo     is already committed.
)

echo.
echo === Commits not yet on GitHub ===
git log origin/main..main --oneline
echo ---------------------------------
echo.

echo Pushing to GitHub...
git push -u origin main
IF ERRORLEVEL 1 (
  echo.
  echo [X] PUSH FAILED - read the message above:
  echo     "Authentication failed" / "could not read Username"  => sign in / set a GitHub token
  echo     "rejected" / "non-fast-forward"                      => run pushforce.bat instead
) ELSE (
  echo.
  echo ===== Pushed OK =====
)
echo.
pause
