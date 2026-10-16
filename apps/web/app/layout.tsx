import type { Metadata, Viewport } from "next";
import { DM_Sans, Plus_Jakarta_Sans } from "next/font/google";
import type { ReactNode } from "react";
import Analytics from "../components/Analytics";
import "./globals.css";

const plusJakartaSans = Plus_Jakarta_Sans({
  variable: "--font-plus-jakarta-sans",
  weight: "variable",
  subsets: ["latin"],
  display: "swap",
});
const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  weight: "variable",
  axes: ["opsz"],
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://recurmail.com"),
  title: "RecurMail",
  description: "Send recurring emails from your own Gmail.",
  applicationName: "RecurMail",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#6d3bef",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className={[plusJakartaSans.variable, dmSans.variable].join(" ")}
    >
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
