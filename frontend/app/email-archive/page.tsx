import { redirect } from 'next/navigation';

/** Email archive was removed from the product; send users to the dashboard. */
export default function EmailArchiveRedirectPage() {
  redirect('/dashboard');
}
