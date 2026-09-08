$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskNodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($taskNodeCommand) {
  $taskNodePath = $taskNodeCommand.Source
} else {
  $taskNodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $taskNodePath)) { throw 'Node.js 22.13 이상을 설치해 주세요.' }
Write-Host '언제 만날래를 실행합니다. 종료하려면 Ctrl+C를 누르세요.'
& $taskNodePath 'node_modules/vinext/dist/cli.js' dev --host 127.0.0.1
