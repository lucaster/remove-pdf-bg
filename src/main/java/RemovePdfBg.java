import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.PDFStreamEngine;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.contentstream.operator.state.Concatenate;
import org.apache.pdfbox.contentstream.operator.state.Restore;
import org.apache.pdfbox.contentstream.operator.state.Save;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSDictionary;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSObjectKey;
import org.apache.pdfbox.cos.COSStream;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.common.PDStream;
import org.apache.pdfbox.pdmodel.graphics.PDXObject;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.pdfwriter.compress.CompressParameters;
import org.apache.pdfbox.util.Matrix;

import java.awt.geom.Point2D;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;

/**
 * Rimuove da un PDF le immagini che fanno da sfondo alle pagine, cioè quelle
 * che coprono almeno una certa percentuale dell'area della pagina (default 95%).
 * Testo e grafica vettoriale restano intatti.
 *
 * Equivalente Java di remove-pdf-bg.py, basato su Apache PDFBox.
 *
 * Compilazione:  mvn package
 * Esecuzione:    java -jar target/remove-pdf-bg.jar input.pdf
 *
 * Esempi:
 *   java -jar remove-pdf-bg.jar input.pdf
 *   java -jar remove-pdf-bg.jar input.pdf -o pulito.pdf
 *   java -jar remove-pdf-bg.jar input.pdf -e 1,3,10-12       # escludi pagine
 *   java -jar remove-pdf-bg.jar input.pdf -t 90 --dry-run    # solo report
 */
public final class RemovePdfBg {

    private RemovePdfBg() {
    }

    /** Piazzamento di un'immagine: bounding box nello spazio utente (non ruotato). */
    private record Placement(double x0, double y0, double x1, double y1) {
    }

    /** Immagine trovata su una pagina, con la prima posizione in cui è disegnata. */
    private record FoundImage(PDImageXObject image, Placement placement) {
    }

    /**
     * Scanner dei content stream: registra il primo piazzamento di ogni immagine
     * disegnata con l'operatore "Do" (le immagini inline vengono ignorate, come
     * nello script Python con xref == 0). Scende ricorsivamente nei Form XObject,
     * perché gli sfondi di pagina sono spesso lì dentro.
     */
    private static final class ImageScanner extends PDFStreamEngine {

        private final Map<Long, FoundImage> placements = new LinkedHashMap<>();

        ImageScanner() {
            // Di default PDFStreamEngine non registra alcun operatore: senza q/Q/cm
            // la CTM resterebbe l'identità e ogni immagine sembrerebbe 1x1 punto.
            addOperator(new Save(this));
            addOperator(new Restore(this));
            addOperator(new Concatenate(this));
        }

        @Override
        protected void processOperator(Operator operator, List<COSBase> operands) throws IOException {
            if ("Do".equals(operator.getName()) && !operands.isEmpty()
                    && operands.get(0) instanceof COSName name) {
                PDXObject xobject;
                try {
                    xobject = getResources().getXObject(name);
                } catch (IOException e) {
                    xobject = null;
                }
                if (xobject instanceof PDImageXObject image) {
                    long xref = xrefOf(image.getCOSObject());
                    Matrix ctm = getGraphicsState().getCurrentTransformationMatrix();
                    placements.putIfAbsent(xref, new FoundImage(image, bboxOfUnitSquare(ctm)));
                    return;
                }
                if (xobject instanceof PDFormXObject form) {
                    increaseLevel();
                    try {
                        if (getLevel() > 50) {
                            return;
                        }
                        showForm(form);
                    } finally {
                        decreaseLevel();
                    }
                    return;
                }
            }
            super.processOperator(operator, operands);
        }
    }

    /** Converte '1,3,5-7' (numerazione da 1) in un set di indici da 0.
     *  Supporta anche intervalli aperti: '5-' (dalla 5 alla fine), '-3' (fino alla 3). */
    static Set<Integer> parsePages(String spec, int nPages) {
        Set<Integer> result = new TreeSet<>();
        if (spec == null || spec.isBlank()) {
            return result;
        }
        for (String part : spec.replace(" ", "").split(",")) {
            if (part.isEmpty()) {
                continue;
            }
            int start;
            int end;
            int dash = part.indexOf('-');
            if (dash >= 0) {
                String a = part.substring(0, dash);
                String b = part.substring(dash + 1);
                start = a.isEmpty() ? 1 : Integer.parseInt(a);
                end = b.isEmpty() ? nPages : Integer.parseInt(b);
            } else {
                start = end = Integer.parseInt(part);
            }
            if (start < 1 || end > nPages || start > end) {
                throw new IllegalArgumentException(
                        "Intervallo di pagine non valido: '" + part + "' (il PDF ha " + nPages + " pagine)");
            }
            for (int p = start; p <= end; p++) {
                result.add(p - 1);
            }
        }
        return result;
    }

    private static Placement bboxOfUnitSquare(Matrix ctm) {
        Point2D.Float p0 = ctm.transformPoint(0f, 0f);
        Point2D.Float p1 = ctm.transformPoint(1f, 0f);
        Point2D.Float p2 = ctm.transformPoint(1f, 1f);
        Point2D.Float p3 = ctm.transformPoint(0f, 1f);
        double x0 = Math.min(Math.min(p0.x, p1.x), Math.min(p2.x, p3.x));
        double y0 = Math.min(Math.min(p0.y, p1.y), Math.min(p2.y, p3.y));
        double x1 = Math.max(Math.max(p0.x, p1.x), Math.max(p2.x, p3.x));
        double y1 = Math.max(Math.max(p0.y, p1.y), Math.max(p2.y, p3.y));
        return new Placement(x0, y0, x1, y1);
    }

    /** Frazione di area della pagina coperta dall'immagine (ritagliata ai bordi della pagina).
     *  Sia le coordinate dell'immagine sia il crop box sono non ruotati. */
    private static double coverage(Placement bbox, PDRectangle pageRect) {
        double ix0 = Math.max(bbox.x0(), pageRect.getLowerLeftX());
        double iy0 = Math.max(bbox.y0(), pageRect.getLowerLeftY());
        double ix1 = Math.min(bbox.x1(), pageRect.getLowerLeftX() + pageRect.getWidth());
        double iy1 = Math.min(bbox.y1(), pageRect.getLowerLeftY() + pageRect.getHeight());
        if (ix1 <= ix0 || iy1 <= iy0) {
            return 0.0;
        }
        return ((ix1 - ix0) * (iy1 - iy0)) / (pageRect.getWidth() * pageRect.getHeight());
    }

    /** Identificativo (equivalente della xref) di un oggetto. */
    private static long xrefOf(COSBase base) {
        if (base == null) {
            return -1;
        }
        COSObjectKey key = base.getKey();
        return key != null ? key.getNumber() : System.identityHashCode(base);
    }

    /**
     * Toglie l'immagine SOLO da questa pagina, eliminando dalla content stream
     * l'operatore che la disegna. Serve quando l'immagine è condivisa con pagine
     * escluse: la cancellazione globale agirebbe su tutte le pagine.
     */
    private static boolean stripImageFromPage(PDDocument doc, PDPage page, String name) throws IOException {
        if (!page.hasContents()) {
            return false;
        }
        Pattern pattern = Pattern.compile("(?<![\\w/])/" + Pattern.quote(name) + "\\s+Do\\b");
        byte[] data;
        try (InputStream in = page.getContents()) {
            data = in.readAllBytes();
        }
        String text = new String(data, StandardCharsets.ISO_8859_1);
        String replaced = pattern.matcher(text).replaceAll("");
        if (replaced.equals(text)) {
            return false;
        }
        page.setContents(new PDStream(doc,
                new ByteArrayInputStream(replaced.getBytes(StandardCharsets.ISO_8859_1))));
        return true;
    }

    /** Sostituisce l'oggetto immagine, ovunque sia referenziato, con un'immagine
     *  1x1 completamente trasparente (mascherata da un /SMask tutto a zero). È
     *  l'equivalente di Page.delete_image() di PyMuPDF: agisce sull'oggetto unico
     *  nel file, quindi funziona anche quando l'immagine è disegnata dentro un
     *  Form XObject condiviso. */
    private static void replaceImageWithTransparent(PDDocument doc, COSStream stream) throws IOException {
        COSStream mask = doc.getDocument().createCOSStream();
        mask.setItem(COSName.TYPE, COSName.XOBJECT);
        mask.setItem(COSName.SUBTYPE, COSName.IMAGE);
        mask.setInt(COSName.WIDTH, 1);
        mask.setInt(COSName.HEIGHT, 1);
        mask.setItem(COSName.COLORSPACE, COSName.DEVICEGRAY);
        mask.setInt(COSName.BITS_PER_COMPONENT, 8);
        try (OutputStream out = mask.createOutputStream(COSName.FLATE_DECODE)) {
            out.write(0);
        }

        for (COSName key : new ArrayList<>(stream.keySet())) {
            stream.removeItem(key);
        }
        stream.setItem(COSName.TYPE, COSName.XOBJECT);
        stream.setItem(COSName.SUBTYPE, COSName.IMAGE);
        stream.setInt(COSName.WIDTH, 1);
        stream.setInt(COSName.HEIGHT, 1);
        stream.setItem(COSName.COLORSPACE, COSName.DEVICEGRAY);
        stream.setInt(COSName.BITS_PER_COMPONENT, 8);
        stream.setItem(COSName.SMASK, mask);
        try (OutputStream out = stream.createOutputStream(COSName.FLATE_DECODE)) {
            out.write(0);
        }
    }

    /** Tutte le immagini referenziate (anche dentro i Form XObject) dalle risorse. */
    private static void collectImageXrefs(PDResources resources, Set<Long> out, int depth)
            throws IOException {
        if (resources == null || depth > 50) {
            return;
        }
        COSBase xo = resources.getCOSObject().getDictionaryObject(COSName.XOBJECT);
        if (!(xo instanceof COSDictionary dict)) {
            return;
        }
        for (COSName name : dict.keySet()) {
            if (resources.isImageXObject(name)) {
                out.add(xrefOf(dict.getDictionaryObject(name)));
            } else {
                PDXObject xobject;
                try {
                    xobject = resources.getXObject(name);
                } catch (IOException e) {
                    continue;
                }
                if (xobject instanceof PDFormXObject form) {
                    collectImageXrefs(form.getResources(), out, depth + 1);
                }
            }
        }
    }

    /** Nomi delle immagini nel solo dizionario /XObject di primo livello della
     *  pagina: sono quelli che possono comparire nella content stream della pagina. */
    private static Map<Long, String> pageLevelImageNames(PDResources resources) {
        Map<Long, String> map = new HashMap<>();
        if (resources == null) {
            return map;
        }
        COSBase xo = resources.getCOSObject().getDictionaryObject(COSName.XOBJECT);
        if (!(xo instanceof COSDictionary dict)) {
            return map;
        }
        for (COSName name : dict.keySet()) {
            if (resources.isImageXObject(name)) {
                map.putIfAbsent(xrefOf(dict.getDictionaryObject(name)), name.getName());
            }
        }
        return map;
    }

    private static void removeBackgrounds(Path src, Path dst, double threshold,
                                          Set<Integer> excluded, boolean dryRun) throws IOException {
        try (PDDocument doc = Loader.loadPDF(src.toFile())) {
            int nPages = doc.getNumberOfPages();

            // Immagini usate nelle pagine escluse: l'oggetto immagine è unico nel file,
            // quindi se è condiviso con una pagina esclusa non possiamo sostituirlo
            // globalmente e lo togliamo pagina per pagina dalla content stream.
            Set<Long> protectedXrefs = new HashSet<>();
            for (int i : excluded) {
                collectImageXrefs(doc.getPage(i).getResources(), protectedXrefs, 0);
            }

            Set<Long> alreadyReplaced = new HashSet<>();
            int totalRemoved = 0;
            int pagesTouched = 0;

            for (int i = 0; i < nPages; i++) {
                if (excluded.contains(i)) {
                    System.out.printf("Pagina %4d: esclusa%n", i + 1);
                    continue;
                }
                PDPage page = doc.getPage(i);
                PDRectangle pageRect = page.getCropBox();

                ImageScanner scanner = new ImageScanner();
                scanner.processPage(page);

                Map<Long, String> pageNames = pageLevelImageNames(page.getResources());
                int removedHere = 0;

                for (Map.Entry<Long, FoundImage> entry : scanner.placements.entrySet()) {
                    long xref = entry.getKey();
                    double cov = coverage(entry.getValue().placement(), pageRect);
                    if (cov < threshold) {
                        continue;
                    }
                    if (!dryRun) {
                        if (protectedXrefs.contains(xref)) {
                            String name = pageNames.get(xref);
                            if (name == null || !stripImageFromPage(doc, page, name)) {
                                System.out.printf(
                                        "Pagina %4d: sfondo (xref %d) non rimovibile "
                                                + "(dentro un Form XObject) -> saltato%n",
                                        i + 1, xref);
                                continue;
                            }
                        } else if (!alreadyReplaced.contains(xref)) {
                            replaceImageWithTransparent(doc,
                                    (COSStream) entry.getValue().image().getCOSObject());
                            alreadyReplaced.add(xref);
                        }
                    }
                    removedHere++;
                    System.out.printf("Pagina %4d: %s sfondo (xref %d, copertura %.0f%%)%n",
                            i + 1, dryRun ? "trovato" : "rimosso", xref, cov * 100);
                }

                if (removedHere > 0) {
                    pagesTouched++;
                    totalRemoved += removedHere;
                }
            }

            if (!dryRun) {
                // Come garbage=4 + deflate + use_objstms nello script Python: PDFBox,
                // al salvataggio completo, scrive solo gli oggetti raggiungibili dal
                // trailer (quindi scarta i dati delle immagini rimosse), comprime gli
                // stream e usa gli object stream (/ObjStm).
                System.out.print("\nSalvataggio in corso...");
                System.out.flush();
                doc.save(dst.toFile(), CompressParameters.DEFAULT_COMPRESSION);
                System.out.println();
            }

            System.out.printf("%nImmagini %s: %d su %d pagine (totale pagine: %d)%n",
                    dryRun ? "individuate" : "rimosse", totalRemoved, pagesTouched, nPages);
            if (!dryRun) {
                System.out.println("File salvato in: " + dst);
            }
        }
    }

    private static void usage() {
        System.out.println("""
                Rimuove le immagini di sfondo a pagina intera da un PDF.

                Uso: java -jar remove-pdf-bg.jar [opzioni] INPUT.pdf

                  -o, --output FILE     PDF di output (default: <input>_nobg.pdf)
                  -t, --threshold N     copertura minima della pagina, in % (default: 95)
                  -e, --exclude SPEC    pagine da NON trattare, numerate da 1: es. '1,3,10-12' o '5-'
                  -d, --dry-run         mostra cosa verrebbe rimosso senza scrivere alcun file
                  -h, --help            mostra questo messaggio""");
    }

    private static void fail(String message) {
        System.err.println(message);
        System.exit(1);
    }

    public static void main(String[] args) {
        String input = null;
        String output = null;
        String exclude = "";
        double threshold = 95.0;
        boolean dryRun = false;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "-h", "--help" -> {
                    usage();
                    return;
                }
                case "-o", "--output" -> {
                    if (++i >= args.length) {
                        fail("Manca il valore di --output.");
                    }
                    output = args[i];
                }
                case "-t", "--threshold" -> {
                    if (++i >= args.length) {
                        fail("Manca il valore di --threshold.");
                    }
                    try {
                        threshold = Double.parseDouble(args[i]);
                    } catch (NumberFormatException e) {
                        fail("Soglia non valida: " + args[i]);
                    }
                }
                case "-e", "--exclude" -> {
                    if (++i >= args.length) {
                        fail("Manca il valore di --exclude.");
                    }
                    exclude = args[i];
                }
                case "-d", "--dry-run" -> dryRun = true;
                default -> {
                    if (args[i].startsWith("-")) {
                        System.err.println("Opzione sconosciuta: " + args[i]);
                        usage();
                        System.exit(2);
                    }
                    if (input != null) {
                        fail("È stato indicato più di un file di input.");
                    }
                    input = args[i];
                }
            }
        }

        if (input == null) {
            usage();
            System.exit(2);
        }

        Path src = Path.of(input);
        if (!Files.isRegularFile(src)) {
            fail("File non trovato: " + src);
        }

        String fileName = src.getFileName().toString();
        int dot = fileName.lastIndexOf('.');
        String stem = dot >= 0 ? fileName.substring(0, dot) : fileName;
        Path dst = output != null
                ? Path.of(output)
                : src.resolveSibling(stem + "_nobg.pdf");
        if (src.toAbsolutePath().normalize().equals(dst.toAbsolutePath().normalize())) {
            fail("Il file di output deve essere diverso da quello di input.");
        }

        // Accetta sia 95 che 0.95
        if (threshold > 1) {
            threshold /= 100;
        }
        if (threshold <= 0 || threshold > 1) {
            fail("La soglia deve essere tra 0 e 100 (%).");
        }

        int nPages;
        try (PDDocument doc = Loader.loadPDF(src.toFile())) {
            nPages = doc.getNumberOfPages();
        } catch (IOException e) {
            fail("Impossibile aprire il PDF: " + e.getMessage());
            return;
        }

        Set<Integer> excluded;
        try {
            excluded = parsePages(exclude, nPages);
        } catch (IllegalArgumentException e) {
            fail(e.getMessage());
            return;
        }

        try {
            removeBackgrounds(src, dst, threshold, excluded, dryRun);
        } catch (IOException e) {
            fail("Errore durante l'elaborazione: " + e.getMessage());
        }
    }
}
