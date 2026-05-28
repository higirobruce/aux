import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'aux — a web DAW for mixing & mastering',
  description: 'A pure mixing & mastering studio for the web. Drop the stems, deliver the master.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
