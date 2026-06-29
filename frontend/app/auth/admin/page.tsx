import { redirect } from 'next/navigation';

/** Legacy URL — forward to the dedicated admin login. */
export default function AuthAdminRedirectPage() {
  redirect('/admin/login');
}
