import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReliefReady | A little breathing room",
  description:
    "Protect your commitments, keep care consistent, and find your way back. A Calgary caregiver demo.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
