import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl();
  const lastModified = new Date();

  return [
    { url: `${siteUrl}/`, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${siteUrl}/download`, lastModified, changeFrequency: "daily", priority: 0.9 },
    { url: `${siteUrl}/changelog`, lastModified, changeFrequency: "daily", priority: 0.7 },
  ];
}
