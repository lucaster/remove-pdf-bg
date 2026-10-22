# remove-pdf-bg
Remove background from PDF files to make them REALLY printer-friendly!

## Python CLI

Implementazione originale in `python-cli/remove-pdf-bg.py` (richiede
`pip install pymupdf`):

```bash
python python-cli/remove-pdf-bg.py input.pdf -o pulito.pdf
python python-cli/remove-pdf-bg.py input.pdf -d            # dry-run
python python-cli/remove-pdf-bg.py input.pdf -e 1,3 -t 90  # esclusioni/soglia
```

## Java CLI

Il progetto Maven è in `java-cli/`. Richiede un JDK 17+ (necessario anche per
`jpackage`).

```bash
mvn -f java-cli/pom.xml package        # -> java-cli/target/remove-pdf-bg.jar
mvn -f java-cli/pom.xml package -Pexe  # -> java-cli/target/dist/remove-pdf-bg/
```

Esecuzione da jar:

```bash
java -jar java-cli/target/remove-pdf-bg.jar input.pdf -o pulito.pdf
java -jar java-cli/target/remove-pdf-bg.jar input.pdf -d            # dry-run
java -jar java-cli/target/remove-pdf-bg.jar input.pdf -e 1,3 -t 90  # esclusioni/soglia
```

## Genera un'app-image portatile con `jpackage`:

```
java-cli/target/dist/remove-pdf-bg/
  remove-pdf-bg.exe   # launcher (finestra di console)
  app/                # il jar
  runtime/            # JRE ridotto (jlink: java.base, java.desktop,
                      #   java.logging, jdk.unsupported)
  remove-pdf-bg.ico
```

~64 MB, **nessun Java installato richiesto** sul PC di destinazione: distribuire
l'intera cartella (zipparla). Uso:

```bat
remove-pdf-bg.exe input.pdf -o pulito.pdf
```

## Test (Java vs riferimento Python)

`tests/compare.py` esegue entrambe le implementazioni e confronta stdout e
rendering pixel-per-pixel:

```bash
python tests/compare.py test.pdf
python tests/compare.py test.pdf --dry-run --strict-stdout
python tests/compare.py test.pdf --js          # confronta la CLI TypeScript
```

Requisiti Python: `pip install pymupdf` (numpy opzionale).

## TypeScript CLI

Implementazione Node.js/TypeScript in `ts-cli/` (richiede Node.js 18+). Richiama l'interfaccia identica alle altre implementazioni.

```bash
cd ts-cli
npm install
npm run build  # -> dist/remove-pdf-bg.js
node dist/remove-pdf-bg.js input.pdf -o pulito.pdf
node dist/remove-pdf-bg.js input.pdf -d            # dry-run
node dist/remove-pdf-bg.js input.pdf -e 1,3 -t 90  # esclusioni/soglia
```

## GUI Angular (browser)

Interfaccia web in `ts-angular/`: applicazione Angular (TypeScript) **senza
backend**, che analizza il PDF nel browser, mostra le immagini di sfondo
candidate con anteprima e permette di rimuoverle. Il file non viene mai
caricato su un server.

```bash
cd ts-angular
npm install
npm start          # -> http://localhost:4200
```

Test su tre livelli (unità, componenti Angular, end-to-end con Playwright):

```bash
npm run test:unit  # vitest + Angular TestBed
npm run test:e2e   # Playwright in Chromium
npm run test:all
```

Dettagli, struttura e compatibilità dei browser: `ts-angular/README.md`.

### Build e pubblicazione

```bash
npm run build      # -> ts-angular/dist/ts-angular/browser
npm run preview    # serve la build come un host statico, su http://localhost:8080
```

La build è **statica** (nessun backend) e si pubblica su qualsiasi host:
Netlify, Cloudflare Pages, Vercel, GitHub Pages, nginx. Confronto dei piani
gratuiti e istruzioni: **`ts-angular/DEPLOY.md`**. Tre avvertenze:

1. **HTTPS** — la File System Access API (pulsante "Salva come...") funziona
   solo in un contesto sicuro: `http://localhost` va bene, un IP di rete locale
   in chiaro no (in quel caso il pulsante viene nascosto e resta il download).
2. **Sottopercorsi** — la build usa `<base href="/">` di default: per pubblicarla
   in una sottocartella (es. GitHub Pages) usare
   `ng build --base-href /nome-repo/`. Per la root di Cloudflare Pages basta
   `ng build --base-href /` (o usare `build-cloudflare.sh`).
3. **MIME type** — il server deve servire i file `.mjs` come
   `application/javascript`, altrimenti il worker di pdf.js non si carica e le
   anteprime di pagina restano vuote: non usare `python -m http.server`, usare
   `npm run preview` o un host statico.

La GUI NiceGUI equivalente (con server Python locale) si trova in
`python-nicegui/`.
