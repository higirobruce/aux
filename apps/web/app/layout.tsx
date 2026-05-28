import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'aux',
  description: 'A web-based mixing & mastering DAW.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* suppressHydrationWarning — browser extensions (ColorZilla, Grammarly)
          inject attributes on <body> before React hydrates, which would otherwise
          surface as a noisy console warning unrelated to the app. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
