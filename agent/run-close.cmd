@echo off
REM Bill the Bull — MARKET CLOSE (Mon-Fri 4:00pm ET via Task Scheduler "Bill-Close").
REM Sequence: (1) reconcile closed positions, (2) refresh dashboard scoreboard, (3) journal new
REM closes (LLM post-mortem), (4) EOD report to #trade-bot — current state, how the day went, what
REM was bought + sold. No orders. Logs to close.log.
cd /d "C:\Users\stanc\OneDrive\Documents\Obsidian\Projects\Trading-Agent\agent"
echo ---- %DATE% %TIME% MARKET CLOSE ---->> "%~dp0close.log"
call npm run refresh >> "%~dp0close.log" 2>&1
call npm run journal >> "%~dp0close.log" 2>&1
call npm run eod-report >> "%~dp0close.log" 2>&1
