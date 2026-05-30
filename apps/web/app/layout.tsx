import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import './globals.css';

// "Warm analog terminal" type pairing — IBM Plex Mono is the workhorse
// (labels, values, transport, track names); Plex Sans carries running text.
// Self-hosted via next/font (no render-blocking @import); exposed as the
// CSS vars that tokens.css points --mono / --sans at.
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
});
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-ibm-plex-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'aux',
  description: 'A web-based mixing & mastering DAW.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexMono.variable} ${plexSans.variable}`}>
      {/* suppressHydrationWarning — browser extensions (ColorZilla, Grammarly)
          inject attributes on <body> before React hydrates, which would otherwise
          surface as a noisy console warning unrelated to the app. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
