export const repositoryOwner = "minhe51805";
export const repositoryName = "TabLer";

/** Canonical GitHub repository URL used across the site and API calls. */
export const repositoryUrl = `https://github.com/${repositoryOwner}/${repositoryName}`;

/** Resolves the public site URL for metadata, sitemap, and robots. */
export function getSiteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000")
  );
}
