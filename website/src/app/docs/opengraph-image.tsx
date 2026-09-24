import { renderOgImage, ogSize, ogContentType } from "../og-image";

export const alt = "TableR Documentation";
export const size = ogSize;
export const contentType = ogContentType;

export default function OpengraphImage() {
  return renderOgImage("Documentation", "Install, connect, query, and understand TableR");
}
