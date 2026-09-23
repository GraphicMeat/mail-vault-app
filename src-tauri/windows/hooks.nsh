; Tauri NSIS installer hooks (bundle.windows.nsis.installerHooks).
;
; The installer only ever stops ${MAINBINARYNAME}.exe. The daemon sidecar is
; a separate process that keeps mailvault-daemon.exe open, so without this an
; update cannot overwrite it and an uninstall leaves it running.

!macro MAILVAULT_KILL_DAEMON
  nsExec::Exec 'taskkill /F /T /IM mailvault-daemon.exe'
  Pop $0
  ; taskkill returns before the image is unmapped.
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro MAILVAULT_KILL_DAEMON
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MAILVAULT_KILL_DAEMON
  ; An update runs the old uninstaller with /UPDATE first; the per-user
  ; registrations must survive that, so only a real uninstall removes them.
  ; Keys match src-core/src/windows_mailto.rs and autostart.rs.
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MailVaultDaemon"
    DeleteRegValue HKCU "Software\RegisteredApplications" "MailVault"
    DeleteRegKey HKCU "Software\Clients\Mail\MailVault"
    DeleteRegKey HKCU "Software\Classes\MailVault.Url.mailto"
  ${EndIf}
!macroend
