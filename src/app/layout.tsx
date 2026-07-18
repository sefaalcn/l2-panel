import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "L2.5 — Üretim Paneli",
  description: "Hailuo üretim paneli",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
