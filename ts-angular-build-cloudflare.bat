@echo off


cd /d "%~dp0ts-angular"

call npm ci
call npx ng build --configuration production --base-href /

REM Copia il file _redirects nella cartella di output
if exist public\_redirects copy public\_redirects dist\ts-angular\browser\_redirects >nul
