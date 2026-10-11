@echo off
setlocal
cd /d "%~dp0"
py -3.12 -c "import encodings, http.server" >nul 2>&1
if errorlevel 1 (
  echo Python 3.12 was not available. Try: py -m http.server 8000
  pause
  exit /b 1
)
start "" /b cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8000/index.html"
py -3.12 -m http.server 8000 --bind 127.0.0.1
endlocal
