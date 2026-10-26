// The stored brand picture is a data URL in settings: kept small by fitting it
// inside this box (an image in the band under the card is ~40-140 px tall).
export const BRAND_MAX = Object.freeze({ w: 1024, h: 256 });

/**
 * A picked file as a PNG data URL for the settings (`socialExport.brandImage`):
 * decoded, fitted inside BRAND_MAX without enlarging, transparency kept.
 * Rejects when the file is no picture the webview can decode.
 */
export async function brandImageFromFile(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const s = Math.min(1, BRAND_MAX.w / bitmap.width, BRAND_MAX.h / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * s));
    canvas.height = Math.max(1, Math.round(bitmap.height * s));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/png');
    if (!url.startsWith('data:image/png;base64,')) throw new Error('brand image encode failed');
    return url;
  } finally {
    bitmap.close?.();
  }
}
