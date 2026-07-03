import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Eclipse — Confidential Dark Pool for FXRP",
  description:
    "Confidential dark pool for FXRP on Flare. Sealed orders matched in a TEE, FTSO-fair uniform clearing, net-only settlement on Coston2.",
};

export const viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark" as const,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
