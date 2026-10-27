import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'فليت فلو — إدارة حركة العربيات',
  description: 'نظام إدارة دخول العربيات وحركتها بين مناطق الشركة'
};

/**
 * Egyptian-Arabic-first application: document language is Arabic and the
 * layout direction is RTL. Latin technical values (plates, emails, IDs) are
 * wrapped in dir="ltr" / unicode-bidi by the components that render them so
 * mixed Arabic/Latin text never corrupts.
 */
export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl">
      <body className="antialiased">{children}</body>
    </html>
  );
}
