import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ghillie, live',
  description: 'An agent that keeps a Highland games volunteer rota true, run one half-day at a time on Claude Managed Agents.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
