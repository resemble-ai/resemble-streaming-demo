import "./globals.css";
import "@radix-ui/themes/styles.css";
import "./theme-config.css";

import type { Metadata } from "next";
import { inter } from "@/app/ui/fonts";
import { Theme } from "@radix-ui/themes";

export const metadata: Metadata = {
  title: "Resemble Streaming Demo",
  description: "A demo app for Resemble Streaming API",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased  bg-slate-100`}>
        <Theme accentColor="green">
          {children}
          {/* <ThemePanel /> */}
        </Theme>
      </body>
    </html>
  );
}
