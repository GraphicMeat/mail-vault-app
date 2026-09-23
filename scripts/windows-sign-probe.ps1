# Signs one throwaway file with the exact signCommand Tauri will use, with
# /debug, then verifies the publisher. Tauri drops signtool's output when
# signing fails, so this is where a broken login, role or dlib shows its reason.
# Needs SIGNTOOL and SIGN_CONFIG from windows-sign-setup.ps1.
param([Parameter(Mandatory)][string]$File)
$ErrorActionPreference = 'Stop'

$cmd = (Get-Content $env:SIGN_CONFIG | ConvertFrom-Json).bundle.windows.signCommand
# /debug must precede the file, which is the last argument.
$signArgs = @($cmd.args | ForEach-Object { if ($_ -eq '%1') { '/debug'; $File } else { $_ } })
& $cmd.cmd @signArgs
if ($LASTEXITCODE -ne 0) { throw "signtool sign failed with exit code $LASTEXITCODE" }

$out = & $env:SIGNTOOL verify /pa /v $File | Out-String
Write-Host $out
if ($LASTEXITCODE -ne 0 -or $out -notmatch 'MODERNIOS APLIKACIJOS') {
  throw "$File is not signed by MODERNIOS APLIKACIJOS"
}
