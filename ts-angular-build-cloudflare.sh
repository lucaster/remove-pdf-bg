#!/bin/bash
set -e

cd "$(dirname "$0")/ts-angular"

npm ci
npm run build -- --configuration production --base-href /

# Copia il file _redirects nella cartella di output
cp public/_redirects dist/ts-angular/browser/_redirects 2>/dev/null || true
