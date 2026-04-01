import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Paramotor Preflight Check",
  description:
    "Check airspace, weather conditions, and fuel mixing before your paramotor flight.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
