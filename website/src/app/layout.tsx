import type { Metadata } from "next";
import { DM_Sans, Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { getSiteUrl } from "@/lib/site";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const dmSans = DM_Sans({
  variable: "--font-display-dm",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const siteUrl = getSiteUrl();

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
        width: 1280,
        height: 801,
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
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${dmSans.variable}`}
        suppressHydrationWarning
      >
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
