!macro customInit
  nsExec::ExecToLog 'taskkill /F /IM "Central de Operações de TI.exe"'
!macroend

!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Central de Operações de TI"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Central de Operações de TI" dir=in action=allow program="$INSTDIR\Central de Operações de TI.exe" enable=yes profile=domain,private'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Central de Operações de TI"'
!macroend
