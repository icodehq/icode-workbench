@echo off
setlocal
cd /d D:\Development\WSLProjects\icode
set CSC_IDENTITY_AUTO_DISCOVERY=false
node "node_modules\.pnpm\electron-builder@26.15.3_electron-builder-squirrel-windows@26.15.3_supports-color@7.2.0\node_modules\electron-builder\cli.js" --win msi --x64 --prepackaged dist\win-unpacked --config config\electron-builder.config.cjs
