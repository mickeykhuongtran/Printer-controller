import type { Metadata } from "next";
import { Inter, DM_Sans, Geist_Mono, Montserrat } from "next/font/google";
import Script from "next/script";
import { ThemeProvider } from "../style-llm/ThemeProvider";
import { ThemeToggle } from "./components/ThemeToggle";
import "./globals.css";

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim() || "";

// Apply the persisted/system theme before the browser paints. Waiting for the
// client provider's first effect causes a light-mode frame and can leave large
// composited/sticky surfaces stale in Chrome after the class switches.
const THEME_INIT_SCRIPT = `
  (() => {
    try {
      let stored = null;
      try {
        stored = localStorage.getItem("theme");
      } catch (_) {
        // A privacy-restricted profile may deny storage while still allowing
        // the system preference to be applied before first paint.
      }
      const preference = stored === "light" || stored === "dark" || stored === "system"
        ? stored
        : "system";
      const resolved = preference === "system"
        ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : preference;
      const root = document.documentElement;
      root.classList.remove("light", "dark");
      root.classList.add(resolved);
      root.style.colorScheme = resolved;
    } catch (_) {
      // CSS keeps a readable light fallback if the browser lacks theme APIs.
    }
  })();
`;

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "ZbrePrinter - Zebra ZPL RFID Label Designer",
    template: "%s | ZbrePrinter",
  },
  description:
    "Design barcode, QR, and RFID labels with a visual editor and print Zebra ZPL to thermal printers through Web Serial or Windows RAW queues.",
  keywords: [
    "label designer",
    "ZPL",
    "thermal printer",
    "Zebra",
    "ZT610R",
    "ZD611R",
    "barcode",
    "QR code",
    "RFID encoding",
    "Web Serial API",
  ],
  icons: {
    icon: "/favicon.ico",
    apple: "/icon-192.png",
  },
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${dmSans.variable} ${geistMono.variable} ${montserrat.variable} antialiased`}
      >
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
        <ThemeProvider defaultTheme="system">
          {children}
          <ThemeToggle />
        </ThemeProvider>
        {GA_MEASUREMENT_ID ? (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
              strategy="afterInteractive"
            />
            <Script id="gtag-init" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                gtag('config', '${GA_MEASUREMENT_ID}');
              `}
            </Script>
          </>
        ) : null}
      </body>
    </html>
  );
}
