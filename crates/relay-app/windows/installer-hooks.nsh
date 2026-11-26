; Relay's hooks into Tauri's NSIS installer (tauri.conf.json bundle.windows.nsis.installerHooks).
;
; Relaunch after an update: Relay's own updater (relay-core win_linux_update) runs this installer
; as `<installer> /S /UPDATE /R`. Tauri's template reopens Relay after a silent install when `/R`
; is given (its .onInstSuccess runs "$INSTDIR\Relay.exe" as the user), so no hook does that. The
; update a Relay 0.x installs through electron-updater runs this installer with its wizard, which
; ends on the finish page whose "Run Relay" box opens it the same way.

!macro NSIS_HOOK_PREINSTALL
  Call RelayRemoveElectronInstall
!macroend

; Relay before 1.0 was an electron-builder install for the current user: an Uninstall key under
; HKCU named by a GUID, DisplayName "Relay <version>" (or "Relay"), and an UninstallString
; '"<folder>\Uninstall Relay.exe" /currentuser'. Its uninstaller runs, silently and waited for,
; before anything of this install is written: it deletes its own shortcuts, named like the ones
; this install makes. It leaves Relay's data (%APPDATA%\Relay): that electron-builder build never
; deleted app data on uninstall, and it is not given --delete-app-data. An install for all users
; (HKLM) needs elevation this current-user installer does not have; it is left alone.
Function RelayRemoveElectronInstall
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  StrCpy $0 0
  ${Do}
    ClearErrors
    EnumRegKey $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
    ${If} ${Errors}
    ${OrIf} $1 == ""
      ${Break}
    ${EndIf}
    IntOp $0 $0 + 1
    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $3 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    StrCpy $4 $2 6
    ${If} $2 != "Relay"
    ${AndIf} $4 != "Relay "
      ${Continue}
    ${EndIf}
    ; Tauri's own entry ("$INSTDIR\uninstall.exe") never matches this.
    ${StrLoc} $4 $3 "\Uninstall Relay.exe" ">"
    ${If} $4 == ""
      ${Continue}
    ${EndIf}
    ; The folder: what precedes "\Uninstall Relay.exe", without the opening quote.
    StrCpy $5 $3 1
    ${If} $5 == '"'
      IntOp $4 $4 - 1
      StrCpy $5 $3 $4 1
    ${Else}
      StrCpy $5 $3 $4
    ${EndIf}
    DetailPrint "Removing the earlier Relay from $5"
    ; With _?= the uninstaller runs in place instead of copying itself to TEMP and returning at
    ; once, so ExecWait waits for the whole uninstall. It must be the last argument.
    ExecWait '$3 /S _?=$5' $4
    DetailPrint "The earlier Relay's uninstaller exited with $4"
    ; Run in place, it cannot delete itself or its folder.
    Delete "$5\Uninstall Relay.exe"
    RMDir "$5"
    ; Its key is gone once it succeeded, so the next key moved down to this index.
    ClearErrors
    ReadRegStr $4 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${If} ${Errors}
      IntOp $0 $0 - 1
    ${EndIf}
  ${Loop}
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
