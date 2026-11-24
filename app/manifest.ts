import type { MetadataRoute } from "next";

/** Aplicația instalabilă (PWA): se poate adăuga pe ecranul telefonului / calculatorului; pe iPhone notificările merg doar după „Adaugă pe ecranul principal”. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Moldovagaz — monitorizare contoare",
    short_name: "Moldovagaz",
    description: "Monitorizare contoare de gaz și antene; notificări despre probleme.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f3f5f8",
    theme_color: "#0b63ce",
    lang: "ro",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
