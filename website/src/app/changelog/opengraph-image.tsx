import { renderOgImage, ogSize, ogContentType } from "../og-image";

export const alt = "TableR Changelog";
export const size = ogSize;
export const contentType = ogContentType;

export default function OpengraphImage() {
  return renderOgImage("Changelog", "Every shipped TableR release with release notes");
}
