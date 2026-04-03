type BadgeProps = {
  tone: 'high' | 'medium' | 'low' | 'missed' | 'pending' | 'done';
  children: React.ReactNode;
};

const toneClass: Record<BadgeProps['tone'], string> = {
  high: 'bg-red-50 text-red-700 ring-1 ring-red-200/80',
  medium: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200/80',
  low: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200/80',
  missed: 'bg-red-50 text-red-700 ring-1 ring-red-200/80',
  pending: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200/80',
  done: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200/80',
};

export function Badge({ tone, children }: BadgeProps) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${toneClass[tone]}`}>
      {children}
    </span>
  );
}
