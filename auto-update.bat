@echo off
REM 烏薩奇漲停版自動更新腳本
REM 排程：每天 16:45 執行

cd /d "D:\claude-auto\usagi-limit"

echo [%date% %time%] Starting usagi-limit auto update...

REM 執行更新（抓分點 + 生成網頁）
node update.mjs

REM 檢查是否成功
if %errorlevel% neq 0 (
    echo [%date% %time%] Error: update.mjs failed with code %errorlevel%
    exit /b %errorlevel%
)

REM Git commit + push
git add docs/ snapshots/ generate.mjs update.mjs
git commit -m "auto: %date% 漲停版自動更新"
git push

echo [%date% %time%] Usagi-limit auto update completed successfully!