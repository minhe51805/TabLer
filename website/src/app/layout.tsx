import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "TableR — A modern database workspace",
  description:
    "Query, explore, visualize, and understand your databases from one focused open-source desktop workspace.",
  applicationName: "TableR",
  icons: {
    icon: [
      {
        url: "/tabler-brand-mark.png",
        type: "image/png",
        sizes: "128x128",
      },
    ],
    shortcut: "/tabler-brand-mark.png",
    apple: "/tabler-brand-mark.png",
  },
  keywords: [
    "database client",
    "SQL editor",
    "database workspace",
    "ER diagram",
    "open source",
    "Tauri",
  ],
  openGraph: {
    title: "TableR — A modern database workspace",
    description:
      "Query, explore, visualize, and understand your databases from one focused desktop workspace.",
    type: "website",
    images: [
      {
        url: "/screenshots/table-r-query-workspace.png",
        width: 1296,
        height: 809,
        alt: "TableR query workspace",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "TableR — A modern database workspace",
    description:
      "Query, explore, visualize, and understand your databases from one focused desktop workspace.",
    images: ["/screenshots/table-r-query-workspace.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
