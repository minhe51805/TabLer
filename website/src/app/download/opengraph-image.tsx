import { renderOgImage, ogSize, ogContentType } from "../og-image";

export const alt = "Download TableR";
export const size = ogSize;
export const contentType = ogContentType;

export default function OpengraphImage() {
  return renderOgImage("Download TableR", "Windows, macOS, and Linux — free and open source");
}
