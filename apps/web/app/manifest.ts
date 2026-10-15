import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RecurMail",
    short_name: "RecurMail",
    description: "Send recurring emails from your own Gmail.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#f3faf6",
    theme_color: "#6d3bef",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
