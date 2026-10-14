param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port,

  [string]$DataRoot = "$env:ProgramData\NexoTI\CentralOperacoes",

  [switch]$VerifyOnly,

  [switch]$DeferStart
)

$ErrorActionPreference = "Stop"
$firewallRuleName = "Nexo TI - Central de Operacoes"

if ($VerifyOnly) {
  $url = "http://127.0.0.1:$Port/login.html"
  $lastError = $null

  for ($attempt = 1; $attempt -le 12; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
        Write-Host "Servidor validado em $url"
        exit 0
      }
    }
    catch {
      $lastError = $_
      Start-Sleep -Seconds 2
    }
  }

  $logPath = Join-Path $DataRoot "logs"
  throw "O serviço foi instalado, mas não respondeu na porta $Port. Consulte os logs em $logPath. Erro: $lastError"
}

$directories = @(
  $DataRoot,
  (Join-Path $DataRoot "dados"),
  (Join-Path $DataRoot "logs")
)

foreach ($directory in $directories) {
  New-Item -Path $directory -ItemType Directory -Force | Out-Null
}

# Somente SYSTEM e administradores locais acessam banco, credenciais e logs.
& icacls.exe $DataRoot /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /T /C | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Não foi possível proteger a pasta de dados $DataRoot."
}

Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

New-NetFirewallRule -DisplayName $firewallRuleName -Direction Inbound -Action Allow -Enabled True -Profile Private -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet | Out-Null

# Recria o registro do serviço de forma idempotente. Ao atualizar o executável
# do wrapper, o Windows precisa concluir a exclusão anterior antes do novo registro.
$serviceName = "NexoTICentral"
$serviceExe = Join-Path $PSScriptRoot "NexoTICentral.exe"
if (-not (Test-Path $serviceExe)) {
  throw "Executável do serviço não encontrado em $serviceExe."
}

$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService) {
  # Em atualizações, o caminho do serviço permanece o mesmo. Reutilizar o
  # registro existente evita o estado transitório do SCM em que o wrapper
  # aparece como Running, mas o processo Node não é iniciado.
  if ($existingService.Status -ne "Stopped") {
    Stop-Service -Name $serviceName -Force -ErrorAction Stop
    $existingService.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
  }
  $existingService.Dispose()
  $existingService = $null
}
else {
  $installOutput = & $serviceExe install 2>&1
  $installExitCode = $LASTEXITCODE
  if ($installExitCode -ne 0) {
    throw "Não foi possível registrar o serviço $serviceName. Código: $installExitCode. Detalhes: $($installOutput -join ' ')"
  }
}

if ($DeferStart) {
  $taskName = "NexoTI-StartAfterUpdate"
  $deferredScriptPath = Join-Path $DataRoot "Start-After-Update.ps1"
  $deferredScript = @'
Start-Sleep -Seconds 8
for ($attempt = 1; $attempt -le 12; $attempt++) {
  & sc.exe start NexoTICentral 2>$null | Out-Null
  Start-Sleep -Seconds 4
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:3000/login.html" -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
      break
    }
  }
  catch {
  }
}
& schtasks.exe /Delete /TN "NexoTI-StartAfterUpdate" /F 2>$null | Out-Null
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
'@

  Set-Content -Path $deferredScriptPath -Value $deferredScript -Encoding UTF8
  & schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null
  $taskCommand = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$deferredScriptPath`""
  $taskOutput = & schtasks.exe /Create /TN $taskName /SC ONSTART /TR $taskCommand /RU SYSTEM /RL HIGHEST /F 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Não foi possível agendar a retomada do serviço: $($taskOutput -join ' ')"
  }

  $runOutput = & schtasks.exe /Run /TN $taskName 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Não foi possível iniciar a tarefa de retomada do serviço: $($runOutput -join ' ')"
  }

  Write-Host "Configuração concluída. O serviço será iniciado após o instalador encerrar."
  exit 0
}

# Durante uma atualização, o SCM pode manter o serviço em transição por alguns
# segundos. Valide a resposta HTTP real, não apenas o estado Running momentâneo.
function Test-NexoEndpoint {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/login.html" -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
  }
  catch {
    return $false
  }
}

function Start-NexoServiceStable {
  param([int]$Cycles = 5)

  $diagnostics = @()
  $status = "Stopped"

  for ($cycle = 1; $cycle -le $Cycles; $cycle++) {
    $scOutput = & cmd.exe /d /c "sc.exe start $serviceName 2>&1"
    $scExitCode = $LASTEXITCODE
    $diagnostics += "sc.exe tentativa $cycle (código $scExitCode): $($scOutput -join ' ')"

    for ($attempt = 1; $attempt -le 10; $attempt++) {
      Start-Sleep -Milliseconds 500
      $status = (Get-Service -Name $serviceName -ErrorAction Stop).Status
      if ($status -eq "Running") { break }
    }

    if ($status -eq "Running") {
      Start-Sleep -Seconds 4
      $status = (Get-Service -Name $serviceName -ErrorAction Stop).Status
      if (($status -eq "Running") -and (Test-NexoEndpoint)) {
        return [PSCustomObject]@{ Status = "Running"; Diagnostics = $diagnostics }
      }

      $diagnostics += "O SCM informou Running, mas a aplicação não respondeu na porta $Port."
      & cmd.exe /d /c "sc.exe stop $serviceName 2>&1" | Out-Null
      for ($stopAttempt = 1; $stopAttempt -le 20; $stopAttempt++) {
        Start-Sleep -Milliseconds 500
        $status = (Get-Service -Name $serviceName -ErrorAction SilentlyContinue).Status
        if ($status -eq "Stopped") { break }
      }
    }

    $wrapperCommand = '"{0}" start 2>&1' -f $serviceExe
    $wrapperOutput = & cmd.exe /d /c $wrapperCommand
    $wrapperExitCode = $LASTEXITCODE
    $diagnostics += "WinSW tentativa $cycle (código $wrapperExitCode): $($wrapperOutput -join ' ')"
    Start-Sleep -Seconds 2
  }

  $finalStatus = (Get-Service -Name $serviceName -ErrorAction SilentlyContinue).Status
  if (($finalStatus -eq "Running") -and -not (Test-NexoEndpoint)) {
    $finalStatus = "Unhealthy"
  }
  return [PSCustomObject]@{
    Status = $finalStatus
    Diagnostics = $diagnostics
  }
}

$startResult = Start-NexoServiceStable

if ($startResult.Status -ne "Running") {
  # Recuperação controlada: como o host WinSW é preservado na atualização,
  # recrie somente o registro quando ele não voltar de forma estável.
  $repairDiagnostics = @($startResult.Diagnostics)
  $stopCommand = '"{0}" stop 2>&1' -f $serviceExe
  $repairDiagnostics += (& cmd.exe /d /c $stopCommand)
  $uninstallCommand = '"{0}" uninstall 2>&1' -f $serviceExe
  $repairDiagnostics += (& cmd.exe /d /c $uninstallCommand)

  for ($attempt = 1; $attempt -le 60; $attempt++) {
    if (-not (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }

  if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
    $diagnosticLog = Join-Path $DataRoot "logs\instalacao-servico.log"
    $repairDiagnostics | Set-Content -Path $diagnosticLog -Encoding UTF8
    throw "O Windows não liberou o registro anterior do serviço. Consulte $diagnosticLog."
  }

  $installCommand = '"{0}" install 2>&1' -f $serviceExe
  $installOutput = & cmd.exe /d /c $installCommand
  $installExitCode = $LASTEXITCODE
  $repairDiagnostics += "Reinstalação WinSW (código $installExitCode): $($installOutput -join ' ')"
  if ($installExitCode -ne 0) {
    $diagnosticLog = Join-Path $DataRoot "logs\instalacao-servico.log"
    $repairDiagnostics | Set-Content -Path $diagnosticLog -Encoding UTF8
    throw "Não foi possível reparar o registro do serviço. Consulte $diagnosticLog."
  }

  $repairedStart = Start-NexoServiceStable
  $repairDiagnostics += $repairedStart.Diagnostics
  $startResult = [PSCustomObject]@{ Status = $repairedStart.Status; Diagnostics = $repairDiagnostics }
}

if ($startResult.Status -ne "Running") {
  $diagnosticLog = Join-Path $DataRoot "logs\instalacao-servico.log"
  $startResult.Diagnostics | Set-Content -Path $diagnosticLog -Encoding UTF8
  throw "O serviço $serviceName não permaneceu ativo. Estado: $($startResult.Status). Consulte $diagnosticLog."
}

Write-Host "Pasta persistente: $DataRoot"
Write-Host "Firewall privado liberado na porta: $Port"
