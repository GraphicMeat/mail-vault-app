// WebKit refuses a canvas past a total-area limit, so a long thread becomes
// numbered pages. Decision from the spec: split, never downscale — a soft
// image is a worse archive than a second file.
export const MAX_PAGE_AREA = 16_700_000;

export function planPages(sizes, maxArea = MAX_PAGE_AREA) {
  if (!sizes.length) return [];
  const width = sizes[0].width;
  const maxHeight = Math.floor(maxArea / width);
  const pages = [];
  let current = [];
  let currentHeight = 0;

  sizes.forEach((size, index) => {
    // A single message taller than one page is the only case that gets cut
    // mid-content, and only after it has a page to itself.
    if (size.height > maxHeight) {
      if (current.length) { pages.push({ items: current }); current = []; currentHeight = 0; }
      for (let offsetY = 0; offsetY < size.height; offsetY += maxHeight) {
        pages.push({
          items: [index],
          slice: { index, offsetY, height: Math.min(maxHeight, size.height - offsetY) },
        });
      }
      return;
    }
    if (currentHeight + size.height > maxHeight && current.length) {
      pages.push({ items: current });
      current = [];
      currentHeight = 0;
    }
    current.push(index);
    currentHeight += size.height;
  });

  if (current.length) pages.push({ items: current });
  return pages;
}

export function stitchPages(canvases, plan, createCanvas = () => document.createElement('canvas')) {
  return plan.map((page) => {
    const width = canvases[page.items[0]].width;
    const height = page.slice
      ? page.slice.height
      : page.items.reduce((sum, i) => sum + canvases[i].height, 0);

    const out = createCanvas();
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    if (page.slice) {
      const source = canvases[page.slice.index];
      ctx.drawImage(source, 0, page.slice.offsetY, width, height, 0, 0, width, height);
    } else {
      let y = 0;
      for (const i of page.items) {
        ctx.drawImage(canvases[i], 0, y);
        y += canvases[i].height;
      }
    }
    return out;
  });
}

export async function canvasToBase64(canvas) {
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}
