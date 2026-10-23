@echo off
setlocal

pushd "%~dp0ts-angular"
if exist dist rmdir /s /q dist
call npm ci
call ng build --configuration production --base-href /
if exist public\_redirects copy public\_redirects dist\ts-angular\browser\_redirects >nul
popd

endlocal