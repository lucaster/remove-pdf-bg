import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.PrintStream;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

class RemovePdfBgTest {
    @TempDir
    Path tempDir;

    private File createSamplePdf(File out) throws Exception {
        try (PDDocument doc = new PDDocument()) {
            BufferedImage img = new BufferedImage(200, 200, BufferedImage.TYPE_INT_RGB);
            for (int y = 0; y < 200; y++) {
                for (int x = 0; x < 200; x++) {
                    img.setRGB(x, y, Color.LIGHT_GRAY.getRGB());
                }
            }
            PDImageXObject pdImage = LosslessFactory.createFromImage(doc, img);
            for (int i = 0; i < 2; i++) {
                PDPage page = new PDPage(PDRectangle.A4);
                doc.addPage(page);
                try (var content = new org.apache.pdfbox.pdmodel.PDPageContentStream(doc, page)) {
                    content.drawImage(pdImage, 0, 0, PDRectangle.A4.getWidth(), PDRectangle.A4.getHeight());
                }
            }
            doc.save(out);
        }
        return out;
    }

    @Test
    void reprocessDoesNotFindStubs() throws Exception {
        File in = tempDir.resolve("in.pdf").toFile();
        createSamplePdf(in);
        File out1 = tempDir.resolve("out1.pdf").toFile();
        File out2 = tempDir.resolve("out2.pdf").toFile();

        RemovePdfBg.main(new String[]{in.getAbsolutePath(), "-o", out1.getAbsolutePath()});

        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        PrintStream ps = new PrintStream(baos);
        PrintStream old = System.out;
        System.setOut(ps);
        try {
            RemovePdfBg.main(new String[]{out1.getAbsolutePath(), "-o", out2.getAbsolutePath()});
        } finally {
            System.setOut(old);
        }
        String out = baos.toString();
        assertTrue(out.contains("Immagini individuate: 0") || out.contains("Immagini rimosse: 0"));
        assertTrue(out2.exists());
    }
}
