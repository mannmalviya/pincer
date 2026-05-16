import type { Metadata } from "next";
import { Inter, Fraunces, Geist_Mono } from "next/font/google";
import "./globals.css";

// ---------------------------------------------------------------------------
// Font setup — matches career-gap:
//   • Inter      → body text (`font-sans`)
//   • Fraunces   → display headlines (`font-serif`, `font-heading`)
//   • Geist Mono → small numeric / metadata captions (`font-mono`)
// next/font self-hosts these as static assets, so no Google requests at runtime.
// ---------------------------------------------------------------------------
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pincer",
  description:
    "Multi-platform launch agent. Draft, post, monitor, and triage comments across Reddit and Discord from one local dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${fraunces.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      {/* suppressHydrationWarning on <body> too: extensions like Grammarly
          inject data-* attributes (data-new-gr-c-s-check-loaded, data-gr-
          ext-installed) onto <body> before React hydrates, which causes a
          hydration mismatch otherwise. */}
      <body
        className="min-h-full flex flex-col font-sans"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
