import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Silver Lining — foil studio",
  description: "Turn an illustration into hot-foil stamping that catches the cursor's light.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
