/**
 * Renders a chart SVG element to a PNG download.
 *
 * Recharts paints with CSS custom properties (var(--accent), theme tokens)
 * that do not survive SVG serialization, so computed fill/stroke values are
 * inlined onto every shape before the SVG is rasterized.
 */
export async function exportSvgAsPng(svg: SVGSVGElement, filename: string): Promise<void> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const sourceShapes = svg.querySelectorAll("*");
  const cloneShapes = clone.querySelectorAll("*");
  sourceShapes.forEach((el, index) => {
    const target = cloneShapes[index] as SVGElement | undefined;
    if (!target) return;
    const computed = getComputedStyle(el as Element);
    if (computed.fill && computed.fill !== "none") target.setAttribute("fill", computed.fill);
    if (computed.stroke && computed.stroke !== "none")
      target.setAttribute("stroke", computed.stroke);
    if (computed.color) target.setAttribute("color", computed.color);
    if (computed.fontSize) target.setAttribute("font-size", computed.fontSize);
    if (computed.fontFamily) target.setAttribute("font-family", computed.fontFamily);
  });

  const box = svg.getBoundingClientRect();
  const width = Math.max(Math.ceil(box.width), 1);
  const height = Math.max(Math.ceil(box.height), 1);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  const serialized = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not rasterize the chart SVG"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    const scale = 2; // retina export
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable");
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0, width, height);

    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png");
    });
    const pngUrl = URL.createObjectURL(png);
    try {
      const link = document.createElement("a");
      link.href = pngUrl;
      link.download = filename;
      link.click();
    } finally {
      URL.revokeObjectURL(pngUrl);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}
