import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { GridShiftProvider } from '@/lib/store';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'GridShift -- Energy Command Center',
  description:
    'Agentic energy optimization: forecast the peak, investigate flexible loads, optimize a schedule, and approve the plan.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-base text-ink">
        {/* Single source of truth for API data, polling and run state. */}
        <GridShiftProvider>{children}</GridShiftProvider>
      </body>
    </html>
  );
}
