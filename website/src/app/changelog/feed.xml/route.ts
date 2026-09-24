import { getTableRReleases } from "@/lib/github-releases";
import { getSiteUrl } from "@/lib/site";

export const revalidate = 3600;

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** RSS 2.0 feed of TableR releases — lets users subscribe to the changelog. */
export async function GET() {
  const siteUrl = getSiteUrl();
  const releases = await getTableRReleases();

  const items = releases
    .map((release) => {
      const pubDate = release.publishedAt ? new Date(release.publishedAt).toUTCString() : "";
      const description = release.body
        ? escapeXml(release.body.slice(0, 500))
        : `TableR ${release.tag}`;
      return `    <item>
      <title>TableR ${escapeXml(release.tag)}</title>
      <link>${escapeXml(release.htmlUrl)}</link>
      <guid isPermaLink="true">${escapeXml(release.htmlUrl)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${description}</description>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>TableR changelog</title>
    <link>${siteUrl}/changelog</link>
    <atom:link href="${siteUrl}/changelog/feed.xml" rel="self" type="application/rss+xml" />
    <description>New TableR releases, straight from GitHub.</description>
    <language>en</language>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
