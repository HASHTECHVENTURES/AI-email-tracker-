import { redirect } from 'next/navigation';

/** Legacy/mistyped auth admin URL: forward to the actual platform admin page. */
export default function AuthAdminRedirectPage() {
  redirect('/admin');
}
