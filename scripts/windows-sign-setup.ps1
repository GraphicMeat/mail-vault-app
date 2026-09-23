# Prepares Azure Artifact Signing on a Windows GitHub runner: fetches the
# signing dlib, finds signtool, and writes a Tauri config overlay holding the
# signCommand. Exports SIGNTOOL and SIGN_CONFIG to later steps.
# Signing lives in the overlay only, so a local Windows build stays unsigned.
$ErrorActionPreference = 'Stop'

$dir = Join-Path $env:RUNNER_TEMP 'artifact-signing'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Invoke-WebRequest -Uri 'https://www.nuget.org/api/v2/package/Microsoft.ArtifactSigning.Client/1.0.128' -OutFile "$dir\client.zip"
Expand-Archive -Path "$dir\client.zip" -DestinationPath "$dir\client" -Force
$dlib = "$dir\client\bin\x64\Azure.CodeSigning.Dlib.dll"
if (-not (Test-Path $dlib)) { throw "dlib not found at $dlib" }

$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' |
  Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1
if (-not $signtool) { throw 'signtool.exe not found' }
Write-Host "signtool: $($signtool.FullName)"

# Endpoint exactly as Microsoft's region table spells it: no trailing slash.
# Only AzureCliCredential (from azure/login) may answer; the others would be
# tried first and managed identity can hang on a runner.
$metadata = @{
  Endpoint = 'https://neu.codesigning.azure.net'
  CodeSigningAccountName = 'MailVault'
  CertificateProfileName = 'MailVaultApp2'
  ExcludeCredentials = @(
    'ManagedIdentityCredential', 'EnvironmentCredential', 'WorkloadIdentityCredential',
    'SharedTokenCacheCredential', 'VisualStudioCredential', 'VisualStudioCodeCredential',
    'AzurePowerShellCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential'
  )
}
$metadata | ConvertTo-Json | Set-Content -Encoding utf8 "$dir\metadata.json"

$overlay = @{ bundle = @{ windows = @{ signCommand = @{
  cmd  = $signtool.FullName
  args = @('sign', '/v', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256',
           '/dlib', $dlib, '/dmdf', "$dir\metadata.json", '/d', 'MailVault', '%1')
} } } }
$overlay | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 "$dir\sign.conf.json"
Get-Content "$dir\sign.conf.json"
"SIGNTOOL=$($signtool.FullName)" >> $env:GITHUB_ENV
"SIGN_CONFIG=$dir\sign.conf.json" >> $env:GITHUB_ENV
