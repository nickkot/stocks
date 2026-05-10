import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Leveraged Options Lab",
  description: "Find far-OTM calls on 3x leveraged ETFs and simulate the path to 100x.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
