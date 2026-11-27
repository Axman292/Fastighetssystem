import type { Metadata } from 'next';
import './globals.css';
import { themeScript } from '@/components/theme';

export const metadata: Metadata = {
  title: 'Fastighetssystem',
  description: 'Fastighetsförvaltning, hyresadministration och ekonomi',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: skriptet sätter klassen dark innan React tar över.
    <html lang="sv" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
