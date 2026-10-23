@echo off
set MSYS_NO_PATHCONV=1
cd /d "%~dp0ts-angular"
call npm ci
call npx ng build --configuration production --base-href /
if exist public\_redirects copy public\_redirects dist\ts-angular\browser\_redirects >nul
