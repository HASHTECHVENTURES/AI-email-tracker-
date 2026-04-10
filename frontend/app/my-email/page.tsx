'use client';

import dynamic from 'next/dynamic';
import { PortalPageLoader } from '@/components/PortalPageLoader';

const MyEmailPageClient = dynamic(() => import('./MyEmailPageClient'), {
  ssr: false,
  loading: () => <PortalPageLoader variant="fullscreen" />,
});

export default function MyEmailPage() {
  return <MyEmailPageClient />;
}
