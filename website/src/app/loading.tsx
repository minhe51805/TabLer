export default function Loading() {
  return (
    <main className="status-page" aria-busy="true">
      <span className="status-spinner" aria-hidden="true" />
      <p>Loading TableR…</p>
    </main>
  );
}
