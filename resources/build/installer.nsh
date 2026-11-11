; Custom NSIS hooks for iCode.
;
; electron-builder upgrades in place by running the uninstaller recorded in the
; registry. Two cases escape that record:
;
;  - a canceled or interrupted install, which never writes the registry entry,
;    leaving its files in the default per-user directory;
;  - an install that changed location, where only the newest location is
;    recorded and the previous directory is orphaned.
;
; Both leave a directory that no electron-builder uninstaller will ever visit
; again. The hooks below remove only a directory that still carries iCode's own
; files, and never the directory currently being installed.

!include LogicLib.nsh

; Only the installer reads the previous registry entry; the uninstaller build
; has no customInit, and an unused Var is a warning (which electron-builder
; treats as an error).
!ifndef BUILD_UNINSTALLER
Var PreviousInstallLocation
!endif
Var DefaultInstallLocation
Var InstalledDir

; A directory page can leave a trailing separator, which would make it compare
; unequal to the registry value and turn the cleanup into "delete the directory
; just installed". Normalize a copy; never mutate $INSTDIR.
!macro iCodeNormalizedInstallDir
  StrCpy $InstalledDir $INSTDIR ""
  StrCpy $0 $InstalledDir "" -1
  ${If} $0 == "\"
    StrCpy $InstalledDir $InstalledDir -1
  ${EndIf}
!macroend

!macro iCodeDetectDefaultInstall
  StrCpy $DefaultInstallLocation "$LOCALAPPDATA\Programs\${APP_FILENAME}"
  ; Only treat the default directory as ours when it still holds iCode files.
  ; The names cover an interrupted install that never wrote the executable.
  ${IfNot} ${FileExists} "$DefaultInstallLocation\${APP_EXECUTABLE_FILENAME}"
  ${AndIfNot} ${FileExists} "$DefaultInstallLocation\resources.pak"
  ${AndIfNot} ${FileExists} "$DefaultInstallLocation\icudtl.dat"
  ${AndIfNot} ${FileExists} "$DefaultInstallLocation\resources\app.asar"
    StrCpy $DefaultInstallLocation ""
  ${EndIf}
!macroend

!macro customInit
  ; Read the registry before this install replaces the entry. The key comes from
  ; multiUser.nsh, which the main script includes before this macro is expanded;
  ; SHELL_CONTEXT is HKCU or HKLM after initMultiUser picked the install mode.
  ReadRegStr $PreviousInstallLocation SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ; A trailing separator would make the comparison against $INSTDIR miss and
  ; could turn the cleanup into "delete the directory just installed".
  StrCpy $0 $PreviousInstallLocation "" -1
  ${If} $0 == "\"
    StrCpy $PreviousInstallLocation $PreviousInstallLocation -1
  ${EndIf}
  !insertmacro iCodeDetectDefaultInstall
!macroend

!macro customInstall
  !insertmacro iCodeNormalizedInstallDir
  ; The registered location is normally removed by uninstallOldVersion. Anything
  ; left here was locked or skipped by that uninstaller.
  ${If} $PreviousInstallLocation != ""
  ${AndIf} $PreviousInstallLocation != $InstalledDir
  ${AndIf} ${FileExists} "$PreviousInstallLocation\${APP_EXECUTABLE_FILENAME}"
    RMDir /r /REBOOTOK "$PreviousInstallLocation"
  ${EndIf}

  ; An interrupted first install has no registry entry at all.
  ${If} $DefaultInstallLocation != ""
  ${AndIf} $DefaultInstallLocation != $InstalledDir
  ${AndIf} $DefaultInstallLocation != $PreviousInstallLocation
    RMDir /r /REBOOTOK "$DefaultInstallLocation"
  ${EndIf}
!macroend

!macro customUnInit
  !insertmacro iCodeDetectDefaultInstall
!macroend

!macro customUnInstall
  ; Leave no orphaned default directory when the registered install is elsewhere.
  !insertmacro iCodeNormalizedInstallDir
  ${If} $DefaultInstallLocation != ""
  ${AndIf} $DefaultInstallLocation != $InstalledDir
    RMDir /r /REBOOTOK "$DefaultInstallLocation"
  ${EndIf}
!macroend
