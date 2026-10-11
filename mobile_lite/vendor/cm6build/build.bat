@echo off
REM Rebuild the vendored CodeMirror 6 bundle (..\codemirror6.js).
REM Node + npm are only needed for this build step - the app always uses the committed bundle.
REM If the default registry is unreachable add: --registry=https://registry.npmmirror.com
cd /d "%~dp0"
if not exist node_modules (
  call npm install --no-audit --no-fund
  if errorlevel 1 call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
)
call npx esbuild entry.js --bundle --format=esm --minify --legal-comments=eof --banner:js="/*! CodeMirror 6 (MIT, https://codemirror.net) - vendored ES module bundle for mobile_lite. Rebuild: mobile_lite/vendor/cm6build/build.bat */" --outfile=..\codemirror6.js
