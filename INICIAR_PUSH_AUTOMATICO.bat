@echo off
cd /d "%~dp0"
echo ============================================
echo EL TABLON - PUSH AUTOMATICO ONESIGNAL FIX 403
echo ============================================
call npm install
call npm start
pause
