import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: {
    default: 'Platform Admin',
    template: '%s · Platform Admin',
  },
  description: 'Platform administration for tenant operations and billing.',
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
