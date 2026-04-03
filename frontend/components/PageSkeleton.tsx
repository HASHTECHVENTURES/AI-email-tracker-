'use client';

function Pulse({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-slate-200/60 ${className ?? ''}`} />;
}

export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Pulse className="h-4 w-48" />
        <Pulse className="h-3 w-72" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-2xl border border-slate-200/60 bg-white p-6 shadow-card"
          >
            <Pulse className="mb-4 h-3 w-24" />
            <Pulse className="mb-3 h-8 w-20" />
            <Pulse className="h-3 w-32" />
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-slate-200/60 bg-white p-6 shadow-card">
        <Pulse className="mb-4 h-4 w-36" />
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <Pulse key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="rounded-2xl border border-slate-200/60 bg-white p-6 shadow-card">
      <Pulse className="mb-6 h-4 w-40" />
      <div className="space-y-3">
        <Pulse className="h-10 w-full rounded-lg" />
        {Array.from({ length: rows }, (_, i) => (
          <Pulse key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
