import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const satoshi = localFont({
  src: [
    { path: "../../public/fonts/satoshi-400.woff2", weight: "400", style: "normal" },
    { path: "../../public/fonts/satoshi-500.woff2", weight: "500", style: "normal" },
    { path: "../../public/fonts/satoshi-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-satoshi",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Asset Screener | Lekker",
  description: "Real-time multi-asset screener with technical signals",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${satoshi.variable} ${geistMono.variable} antialiased min-h-screen`}
        style={{ background: "var(--bg)", color: "var(--text)" }}
      >
        {/* No wrapper z-index — the Bracket aesthetic is flat. The detail
            side panel renders at z-40/z-41 via its own portal-like position
            fixed (see AssetDetailPanel). */}
        {children}
      </body>
    </html>
  );
}
