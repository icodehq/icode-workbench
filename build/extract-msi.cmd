@echo off
setlocal
cd /d D:\Development\WSLProjects\icode
msiexec.exe /a "dist\ADE 0.1.0.msi" /qn TARGETDIR="D:\Development\WSLProjects\icode\build\msi-extract" /L*v "D:\Development\WSLProjects\icode\build\msi-extract.log"
