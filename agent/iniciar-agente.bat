@echo off
title Agente de impresion - La Birriaza
cd /d "%~dp0"
:inicio
node agente-impresion.js
echo El agente se detuvo. Reiniciando en 5 segundos...
timeout /t 5 /nobreak >nul
goto inicio
