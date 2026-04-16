import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Internal Dashboard — Anticipy",
  description: "Internal team dashboard: all documents, research, orders, and findings.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function InternalLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
