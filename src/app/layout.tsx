import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FLEETFLOW — Smart Vehicle Movement System',
  description: 'Industrial vehicle entry, zone tracking and gate management.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-ff-bg text-slate-100 antialiased">{children}</body>
    </html>
  );
}
