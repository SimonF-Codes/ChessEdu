import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'ChessEdu',
  description: 'A chess trainer built on your own games.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
