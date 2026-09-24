import { ImageResponse } from "next/og";

export const ogSize = { width: 1200, height: 630 };
export const ogContentType = "image/png";

/**
 * Shared OG image layout — brand mark + title + tagline on the dark
 * gradient. Each route's opengraph-image.tsx passes its own title.
 */
export function renderOgImage(title: string, subtitle: string) {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #0b1220 0%, #10233b 100%)",
        color: "#ffffff",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 18,
          marginBottom: 28,
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 16,
            background: "#087efc",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 36,
            fontWeight: 700,
          }}
        >
          T
        </div>
        <div style={{ fontSize: 52, fontWeight: 700, letterSpacing: -1 }}>TableR</div>
      </div>
      <div
        style={{
          fontSize: 40,
          fontWeight: 600,
          color: "#ffffff",
          maxWidth: 960,
          textAlign: "center",
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 26,
          color: "#8fa8c4",
          marginTop: 18,
          maxWidth: 880,
          textAlign: "center",
        }}
      >
        {subtitle}
      </div>
    </div>,
    ogSize,
  );
}
