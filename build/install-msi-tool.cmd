@echo off
setlocal
cd /d D:\Development\WSLProjects\icode\build
if not exist msi-tool mkdir msi-tool
cd msi-tool
if not exist package.json call npm init -y
call npm install electron-builder@26.15.3 --no-audit --no-fund
