export function formatInr(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  }).format(amount);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function portalLoginRolesLine(r?: {
  ceo: number;
  head: number;
  employee: number;
  platform_admin: number;
}): string {
  if (!r) return '';
  const parts: string[] = [];
  if (r.ceo) parts.push(`${r.ceo} CEO`);
  if (r.head) parts.push(`${r.head} mgr`);
  if (r.employee) parts.push(`${r.employee} employee`);
  if (r.platform_admin) parts.push(`${r.platform_admin} platform`);
  return parts.join(' · ');
}
