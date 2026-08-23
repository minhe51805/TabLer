import { ImageResponse } from "next/og";

export const alt = "TableR — A modern database workspace";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
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
          <div style={{ fontSize: 52, fontWeight: 700, letterSpacing: -1 }}>
            TableR
          </div>
        </div>
        <div style={{ fontSize: 34, color: "#c9d7e6", maxWidth: 900, textAlign: "center" }}>
          Query, explore, visualize, and understand your databases
        </div>
        <div style={{ fontSize: 24, color: "#6f8aa6", marginTop: 22 }}>
          Open source · Windows, macOS, Linux
        </div>
      </div>
    ),
    size,
  );
}
