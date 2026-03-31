import type { Metadata } from "next";
import { DM_Serif_Display, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { LenisProvider } from "@/components/LenisProvider";

const dmSerif = DM_Serif_Display({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-dm-serif",
  display: "swap",
});

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-jakarta",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Anticipy — Vibe your life.",
  description:
    "The AI wearable that listens to your life and handles what needs handling. Brushed titanium. 8 grams. $149.",
  openGraph: {
    title: "Anticipy — Vibe your life.",
    description:
      "The AI wearable that listens to your life and handles what needs handling.",
    url: "https://anticipy.ai",
    siteName: "Anticipy",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Anticipy — Vibe your life.",
    description:
      "The AI wearable that listens to your life and handles what needs handling.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${dmSerif.variable} ${jakarta.variable}`}>
      <body className="font-sans antialiased">
        <LenisProvider>{children}</LenisProvider>
      </body>
    </html>
  );
}
