@echo off
REM Bill the Bull — MARKET OPEN (Mon-Fri 9:30am ET via Task Scheduler "Bill-Open").
REM Sequence: (1) morning brief posted to #trade-bot (current state + plans), (2) scan for setups,
REM (3) execute per MODE (gated = proposes; auto = places paper orders under guardrails).
REM Logs to open.log. Place no orders if mode=off.
cd /d "C:\Users\stanc\OneDrive\Documents\Obsidian\Projects\Trading-Agent\agent"
echo ---- %DATE% %TIME% MARKET OPEN ---->> "%~dp0open.log"
call npm run premarket >> "%~dp0open.log" 2>&1
call npm run scan >> "%~dp0open.log" 2>&1
call npm run execute >> "%~dp0open.log" 2>&1
