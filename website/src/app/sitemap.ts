import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site";
import { docHref, docsSlugs } from "@/lib/docs";

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl();
  const lastModified = new Date();

  const docsEntries: MetadataRoute.Sitemap = docsSlugs.map((slug) => ({
    url: `${siteUrl}${docHref(slug)}`,
    lastModified,
    changeFrequency: "weekly",
    priority: slug === "" ? 0.8 : 0.6,
  }));

  return [
    { url: `${siteUrl}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${siteUrl}/download`, lastModified, changeFrequency: "daily", priority: 0.9 },
    { url: `${siteUrl}/changelog`, lastModified, changeFrequency: "daily", priority: 0.7 },
    ...docsEntries,
  ];
}
