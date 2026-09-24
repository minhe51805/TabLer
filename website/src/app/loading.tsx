/**
 * Route-level loading UI — a quiet spinner on the neumorphic canvas while
 * the server component streams in. Matches .status-page so transitions
 * between loading / error / 404 feel like the same surface.
 */
export default function Loading() {
  return (
    <main className="status-page" aria-busy="true" aria-label="Loading">
      <div className="status-spinner" aria-hidden="true" />
    </main>
  );
}
