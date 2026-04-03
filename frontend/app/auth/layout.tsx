/** Auth uses search params + client session; avoid static prerender edge cases. */
export const dynamic = 'force-dynamic';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
