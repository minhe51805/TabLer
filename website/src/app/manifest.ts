import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TableR",
    short_name: "TableR",
    description:
      "Query, explore, visualize, and understand your databases from one focused open-source desktop workspace.",
    start_url: "/",
    display: "browser",
    background_color: "#f7f9fb",
    theme_color: "#087efc",
    icons: [
      {
        src: "/tabler-brand-mark.png",
        sizes: "128x128",
        type: "image/png",
      },
    ],
  };
}
