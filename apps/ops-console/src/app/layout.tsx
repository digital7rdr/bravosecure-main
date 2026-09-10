import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import {MessengerProvider} from '@/components/messenger/MessengerProvider';

export const metadata: Metadata = {
  title: 'Bravo Ops Console',
  description: 'Bravo Secure — HQ Operations Command Center',
};

// Why: P0-W1. Reading the per-request `x-nonce` here forces this layout
// to render dynamically (no static caching of the wrong nonce) AND Next.js
// uses the header to stamp its framework <script> tags with `nonce=...`,
// which lets middleware drop `'unsafe-inline'` from `script-src`.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? '';
  return (
    <html lang="en">
      <body data-csp-nonce={nonce}>
        <MessengerProvider>{children}</MessengerProvider>
      </body>
    </html>
  );
}
