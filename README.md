# remove-pdf-bg
Remove background from PDF files to make them REALLY printer-friendly!

## Build

Richiede un JDK 17+ (necessario anche per `jpackage`).

```bash
mvn package                 # -> target/remove-pdf-bg.jar (autoconsistente)
mvn package -Pexe           # -> target/dist/remove-pdf-bg/  (vedi sotto)
```

Esecuzione da jar:

```bash
java -jar target/remove-pdf-bg.jar input.pdf -o pulito.pdf
java -jar target/remove-pdf-bg.jar input.pdf -d            # dry-run
java -jar target/remove-pdf-bg.jar input.pdf -e 1,3 -t 90  # esclusioni/soglia
```

## Eseguibile Windows autocontentuto (`-Pexe`)

Genera un'app-image portatile con `jpackage`:

```
target/dist/remove-pdf-bg/
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
python tests/compare.py test.pdf --exe target/dist/remove-pdf-bg/remove-pdf-bg.exe
```

Requisiti Python: `pip install pymupdf` (numpy opzionale).
