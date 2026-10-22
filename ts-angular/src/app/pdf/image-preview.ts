import { DecodedImage, MAX_PREVIEW_DIM } from './image-decoder';

/** Converte un'immagine decodificata in un data URL utilizzabile in un <img>. */
export async function imageToDataUrl(decoded: DecodedImage): Promise<string | null> {
  if (decoded.kind === 'encoded') {
    const blob = new Blob([decoded.bytes as BlobPart], { type: decoded.mime });
    const scale = Math.min(1, MAX_PREVIEW_DIM / Math.max(decoded.width, decoded.height));
    const targetWidth = Math.max(1, Math.round(decoded.width * scale));
    const targetHeight = Math.max(1, Math.round(decoded.height * scale));
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob, {
        resizeWidth: targetWidth,
        resizeHeight: targetHeight,
        resizeQuality: 'medium',
      });
    } catch {
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas.toDataURL('image/png');
  }

  const canvas = document.createElement('canvas');
  canvas.width = decoded.width;
  canvas.height = decoded.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height), 0, 0);
  return canvas.toDataURL('image/png');
}
