import { redirect } from 'next/navigation';

export default function AddEmployeeRedirectPage() {
  redirect('/employees?add=1');
}
