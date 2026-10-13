@echo off
cd /d "%~dp0"
title Paper Sniper (ne zatvaraj ovaj prozor)
start "" http://localhost:4173
node server.js
pause
