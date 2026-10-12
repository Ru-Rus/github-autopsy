import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
export const metadata: Metadata = {
  title: "GitHub Autopsy — Repository health, with evidence",
  description:
    "Understand how a public GitHub repository evolves through transparent engineering signals.",
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
