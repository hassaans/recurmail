import type { Metadata } from "next";
import { DM_Sans, Plus_Jakarta_Sans } from "next/font/google";
import type { ReactNode } from "react";
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
  description: "A workspace for the RecurMail web app.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className={[plusJakartaSans.variable, dmSans.variable].join(" ")}
    >
      <body>{children}</body>
    </html>
  );
}
