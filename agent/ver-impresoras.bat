@echo off
title Impresoras instaladas - La Birriaza
cd /d "%~dp0"
node agente-impresion.js --impresoras
pause
