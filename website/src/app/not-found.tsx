import Image from "next/image";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="status-page">
      <Image
        src="/tabler-brand-mark.png"
        width={44}
        height={44}
        alt=""
        aria-hidden="true"
      />
      <h1>Page not found</h1>
      <p>The page you are looking for does not exist or has moved.</p>
      <div className="status-actions">
        <Link className="button button-primary" href="/">
          Back to home
        </Link>
        <Link className="button button-secondary" href="/download">
          Download TableR
        </Link>
      </div>
    </main>
  );
}
