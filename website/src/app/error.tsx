"use client";

import Image from "next/image";
import Link from "next/link";
import { RefreshCw } from "lucide-react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="status-page">
      <Image
        src="/tabler-brand-mark.png"
        width={44}
        height={44}
        alt=""
        aria-hidden="true"
      />
      <h1>Something went wrong</h1>
      <p>
        The page failed to render. This is usually temporary — try again, or
        head back to the homepage.
      </p>
      {error.digest ? <small>Reference: {error.digest}</small> : null}
      <div className="status-actions">
        <button type="button" className="button button-primary" onClick={reset}>
          <RefreshCw size={16} aria-hidden="true" />
          Try again
        </button>
        <Link className="button button-secondary" href="/">
          Back to home
        </Link>
      </div>
    </main>
  );
}
