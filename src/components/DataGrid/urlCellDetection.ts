// ---------------------------------------------------------------------------
// URL / Image cell detection with bounded memoization
//
// `new URL()` parsing is expensive and the same URLs repeat across grid rows
// and renders, so parsed results are memoized in bounded caches. All values
// are deterministic per input string.
// ---------------------------------------------------------------------------

const URL_RE = /^https?:\/\//i;
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp)(\?.*)?$/i;
const IMAGE_KEYWORD_RE = /\/(logo|img|image|avatar|icon|photo|picture|thumbnail|asset|media|cdn)\//i;

export function isUrlCell(value: string | null): boolean {
  return value !== null && URL_RE.test(value);
}

export function isImageUrl(value: string): boolean {
  return IMAGE_EXT_RE.test(value) || IMAGE_KEYWORD_RE.test(value);
}

const URL_CACHE_LIMIT = 512;
const urlDomainCache = new Map<string, string>();
const faviconUrlCache = new Map<string, string | null>();

export function getUrlDomain(value: string): string {
  const cached = urlDomainCache.get(value);
  if (cached !== undefined) return cached;
  let result: string;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "");
    const shortPath = path.length > 24 ? path.slice(0, 22) + "…" : path;
    result = `${host}${shortPath}`;
  } catch {
    result = value.length > 32 ? value.slice(0, 30) + "…" : value;
  }
  if (urlDomainCache.size >= URL_CACHE_LIMIT) urlDomainCache.clear();
  urlDomainCache.set(value, result);
  return result;
}

export function getFaviconUrl(value: string): string | null {
  if (faviconUrlCache.has(value)) return faviconUrlCache.get(value)!;
  let result: string | null;
  try {
    const url = new URL(value);
    result = `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=64`;
  } catch {
    result = null;
  }
  if (faviconUrlCache.size >= URL_CACHE_LIMIT) faviconUrlCache.clear();
  faviconUrlCache.set(value, result);
  return result;
}
