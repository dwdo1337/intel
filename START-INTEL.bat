@echo off
REM Starts the intel. Command Deck and opens it in your browser.
REM
REM The deck used to ship as a packaged .exe. It does not any more: it is a
REM local server plus a browser extension, so this script starts the server and
REM leaves it running. Closing this window stops the deck.

cd /d "%~dp0app"

if not exist "node_modules" (
  echo Installing dependencies, one time only...
  call npm install || goto :failed
)

if not exist "client\dist\index.html" (
  echo Building the interface, one time only...
  call npm run build || goto :failed
)

echo.
echo   intel. Command Deck  --  http://localhost:5050
echo   Leave this window open. Closing it stops the deck.
echo.

start "" http://localhost:5050
call npm start
goto :eof

:failed
echo.
echo Startup failed. The error above says why; docs\SETUP.md covers the usual causes.
pause
