@echo off
setlocal
cd /d D:\Development\WSLProjects\icode
set CSC_IDENTITY_AUTO_DISCOVERY=false
call build\msi-tool\node_modules\.bin\electron-builder.cmd --win msi --x64 --prepackaged dist\win-unpacked --config config\electron-builder.config.cjs
