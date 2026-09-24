export const revalidate = 86400;

/** RFC 9116 security.txt — where to report vulnerabilities. */
export function GET() {
  const body = `Contact: https://github.com/minhe51805/TabLer/security/advisories/new
Expires: 2027-12-31T23:59:59.000Z
Preferred-Languages: en
Canonical: https://tabler.dev/.well-known/security.txt
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
