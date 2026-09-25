/**
 * Route-level loading for /docs/* — a skeleton article in the content column
 * while the doc body streams in. The docs layout (header + sidebar) is
 * already on screen, so only the article area needs a placeholder.
 */
export default function DocsLoading() {
  return (
    <div className="docs-loading" aria-busy="true" aria-label="Loading">
      <div className="docs-loading-title" />
      <div className="docs-loading-lede" />
      <div className="docs-loading-lede docs-loading-lede--short" />
      {Array.from({ length: 4 }, (_, i) => (
        <div className="docs-loading-block" key={i} />
      ))}
    </div>
  );
}
