#!/bin/bash
set -e

export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/ts-angular"

npm ci
npx ng build --configuration production --base-href /

# Copia il file _redirects nella cartella di output
cp public/_redirects dist/ts-angular/browser/_redirects 2>/dev/null || true

