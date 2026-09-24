import { renderOgImage, ogSize, ogContentType } from "../og-image";

export const alt = "TableR plugins";
export const size = ogSize;
export const contentType = ogContentType;

export default function OpengraphImage() {
  return renderOgImage("Plugins", "Official database driver plugins for TableR");
}
