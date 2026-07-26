; Registers ownbrowser as a candidate default browser so it shows up in
; Windows "Default apps" and can handle http/https links from other programs
; (spec 10, Systemintegration).

!macro customInstall
  WriteRegStr SHCTX "SOFTWARE\RegisteredApplications" "ownbrowser" "SOFTWARE\Clients\StartMenuInternet\ownbrowser\Capabilities"

  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\ownbrowser" "" "ownbrowser"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\ownbrowser\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\ownbrowser\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'

  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\ownbrowser\Capabilities" "ApplicationName" "ownbrowser"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\ownbrowser\Capabilities" "ApplicationDescription" "Privacy-first browser with split view"

  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\ownbrowser\Capabilities\URLAssociations" "http" "ownbrowserHTML"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\ownbrowser\Capabilities\URLAssociations" "https" "ownbrowserHTML"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\ownbrowser\Capabilities\FileAssociations" ".html" "ownbrowserHTML"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\ownbrowser\Capabilities\FileAssociations" ".htm" "ownbrowserHTML"

  WriteRegStr SHCTX "SOFTWARE\Classes\ownbrowserHTML" "" "ownbrowser HTML Document"
  WriteRegStr SHCTX "SOFTWARE\Classes\ownbrowserHTML\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "SOFTWARE\RegisteredApplications" "ownbrowser"
  DeleteRegKey SHCTX "SOFTWARE\Clients\StartMenuInternet\ownbrowser"
  DeleteRegKey SHCTX "SOFTWARE\Classes\ownbrowserHTML"
!macroend
