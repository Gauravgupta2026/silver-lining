import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = localFont({ src: "./fonts/geist-latin.woff2", variable: "--font-geist-sans-loaded", weight: "100 900", display: "swap" });
const geistMono = localFont({ src: "./fonts/geist-mono-latin.woff2", variable: "--font-geist-mono-loaded", weight: "100 900", display: "swap" });

export const metadata: Metadata = {
  title: "Silver Lining — foil studio",
  description: "Turn an illustration into hot-foil stamping that catches the cursor's light.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
