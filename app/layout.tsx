import type { Metadata, Viewport } from "next";
import { Figtree } from "next/font/google";
import "./globals.css";

const figtree = Figtree({ subsets: ["latin"], display: "swap", variable: "--rr-font" });

export const metadata: Metadata = {
  title: "ReliefReady",
  description:
    "When you suddenly have to care for family in Calgary: clear your week, keep the care details in one place, and get back to normal after.",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-CA" className={figtree.variable}>
      <body>{children}</body>
    </html>
  );
}
