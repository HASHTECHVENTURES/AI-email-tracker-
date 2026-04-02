type BadgeProps = {
  tone: 'high' | 'medium' | 'low' | 'missed' | 'pending' | 'done';
  children: React.ReactNode;
};

const toneClass: Record<BadgeProps['tone'], string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-gray-100 text-gray-700',
  missed: 'bg-red-100 text-red-700',
  pending: 'bg-amber-100 text-amber-700',
  done: 'bg-emerald-100 text-emerald-700',
};

export function Badge({ tone, children }: BadgeProps) {
  return (
    <span className={`inline-flex rounded-lg px-2.5 py-1 text-xs font-semibold ${toneClass[tone]}`}>
      {children}
    </span>
  );
}
