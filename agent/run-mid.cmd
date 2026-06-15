@echo off
REM Bill the Bull — MID-DAY trade cycle (Mon-Fri 12:30pm ET via Task Scheduler "Bill-Mid").
REM Re-scan for fresh setups + execute per MODE. No reports — open + close handle those.
REM Logs to mid.log.
cd /d "C:\Users\stanc\OneDrive\Documents\Obsidian\Projects\Trading-Agent\agent"
echo ---- %DATE% %TIME% MID-DAY ---->> "%~dp0mid.log"
call npm run scan >> "%~dp0mid.log" 2>&1
call npm run execute >> "%~dp0mid.log" 2>&1
