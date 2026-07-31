; Windows system integration, and the uninstaller's way back out.
;
; ## Two jobs
;
; **Default browser.** Registers this browser as a candidate in Windows "Default apps" so it can
; handle http/https links from other programs (spec 10, Systemintegration). Windows only offers
; applications that have written this set of keys; without them the browser cannot be chosen as the
; default however hard the user tries.
;
; **Uninstall, findable.** NSIS writes `Uninstall <product>.exe` into the install directory and an
; entry under the registry's `Uninstall` key by itself, so "Apps & features" lists it. What it does not
; write is a Start-menu entry, and the absence was reported as there being no uninstaller at all — see
; the comment beside `CreateShortCut` below for why that report is right rather than mistaken.
;
; ## Every name comes from a define
;
; Nothing here spells the product out any more. It used to: every key below said `ownbrowser`, which is
; what this project was called before it was called `tessera`, while `productName` in
; `electron-builder.yml` has said `tessera` throughout. So the browser offered itself to Windows under
; one name while being installed under another — "Default apps" listed a product the user had never
; installed, the `.html` association pointed at a class named after it, and `customUnInstall` then
; cleaned up that product's keys and left the real one's behind on every uninstall.
;
; `${PRODUCT_NAME}` and `${APP_EXECUTABLE_FILENAME}` are defined by electron-builder out of
; `electron-builder.yml`, so a rename reaches this file on its own. `tests/architecture.test.ts` asserts
; that no product name appears here as a literal, because this is a mistake that has already been made
; once and it is invisible until somebody installs on Windows and reads a registry key.

!macro customInstall
  ; --- default-browser candidate ---------------------------------------------
  WriteRegStr SHCTX "SOFTWARE\RegisteredApplications" "${PRODUCT_NAME}" "SOFTWARE\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities"

  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\${PRODUCT_NAME}" "" "${PRODUCT_NAME}"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\${PRODUCT_NAME}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\${PRODUCT_NAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'

  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities" "ApplicationDescription" "Privacy-first browser with split view"

  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities\URLAssociations" "http" "${PRODUCT_NAME}HTML"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities\URLAssociations" "https" "${PRODUCT_NAME}HTML"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities\FileAssociations" ".html" "${PRODUCT_NAME}HTML"
  WriteRegStr SHCTX "SOFTWARE\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities\FileAssociations" ".htm" "${PRODUCT_NAME}HTML"

  WriteRegStr SHCTX "SOFTWARE\Classes\${PRODUCT_NAME}HTML" "" "${PRODUCT_NAME} HTML Document"
  WriteRegStr SHCTX "SOFTWARE\Classes\${PRODUCT_NAME}HTML\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; --- the uninstaller, where somebody will actually look for it --------------
  ;
  ; Reported as "es gibt keine uninstall exe für windows". NSIS does write one, and the report is still
  ; correct as an account of what a user can find: with `perMachine: false` the install directory is
  ; %LOCALAPPDATA%\Programs\<product>, not Program Files, so looking in the obvious place turns up
  ; nothing and concluding there is no uninstaller is the reasonable inference.
  ;
  ; A shortcut beside the application's own Start-menu entry answers that, because the Start menu is
  ; where the application was found to begin with. One file, and it removes the whole class of
  ; "installed it, cannot get rid of it".
  ;
  ; Guarded, because `UNINSTALL_FILENAME` is electron-builder's define and not NSIS's own: if a future
  ; version stops defining it, this skips the shortcut rather than failing the build. A release that
  ; does not happen would be the worse outcome, and "Apps & features" keeps working either way.
  !ifdef UNINSTALL_FILENAME
    CreateShortCut "$SMPROGRAMS\Uninstall ${PRODUCT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
  !endif
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "SOFTWARE\RegisteredApplications" "${PRODUCT_NAME}"
  DeleteRegKey SHCTX "SOFTWARE\Clients\StartMenuInternet\${PRODUCT_NAME}"
  DeleteRegKey SHCTX "SOFTWARE\Classes\${PRODUCT_NAME}HTML"

  ; Ours to remove: electron-builder's uninstaller knows the shortcuts it created itself and nothing
  ; about this one. A Start-menu entry pointing at an uninstaller that has deleted itself is exactly
  ; the leftover that makes people distrust an uninstall.
  Delete "$SMPROGRAMS\Uninstall ${PRODUCT_NAME}.lnk"
!macroend
