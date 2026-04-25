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
  metadataBase: new URL("https://www.anticipy.ai"),
  title: "Anticipy — AI Wearable Pendant for Ambient Intent",
  description:
    "Anticipy listens to your life and acts on ambient intent — booking, scheduling, canceling, disputing — all autonomously. Titanium pendant. 8g. $149.",
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  openGraph: {
    title: "Anticipy — AI Wearable Pendant for Ambient Intent",
    description:
      "The AI wearable that listens to your life and handles what needs handling. Brushed titanium. 8 grams. $149.",
    url: "https://www.anticipy.ai",
    siteName: "Anticipy",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Anticipy — AI Wearable Pendant for Ambient Intent",
    description:
      "The AI wearable that listens to your life and handles what needs handling. Brushed titanium. 8 grams. $149.",
  },
  alternates: {
    canonical: "https://www.anticipy.ai",
  },
};

const jsonLdOrganization = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Anticipation Labs Inc.",
  url: "https://www.anticipy.ai",
  foundingDate: "2025",
  foundingLocation: {
    "@type": "Place",
    address: {
      "@type": "PostalAddress",
      addressLocality: "Vancouver",
      addressRegion: "BC",
      addressCountry: "CA",
    },
  },
};

const jsonLdProduct = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Anticipy",
  description:
    "AI wearable pendant that listens to your life and autonomously completes tasks: booking, scheduling, canceling, and more.",
  brand: {
    "@type": "Brand",
    name: "Anticipation Labs",
  },
  category: "AI Wearable",
  offers: {
    "@type": "Offer",
    price: "149",
    priceCurrency: "USD",
    availability: "https://schema.org/PreOrder",
    url: "https://www.anticipy.ai/waitlist",
  },
};

const jsonLdWebSite = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Anticipy",
  url: "https://www.anticipy.ai",
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(jsonLdOrganization),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdProduct) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdWebSite) }}
        />
      </body>
    </html>
  );
}
