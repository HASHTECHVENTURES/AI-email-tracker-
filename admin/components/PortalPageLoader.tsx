'use client';

/** Minimal loading indicator (spinner only) for app shells and route transitions. */
export function PortalPageLoader({
  variant = 'embedded',
  dense = false,
}: {
  variant?: 'fullscreen' | 'embedded';
  dense?: boolean;
}) {
  const spinner = (
    <div
      className="h-9 w-9 shrink-0 rounded-full border-2 border-slate-200 border-t-brand-600 animate-spin"
      aria-hidden
    />
  );

  if (variant === 'fullscreen') {
    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/35 p-6 backdrop-blur-[2px]"
        role="status"
        aria-busy="true"
        aria-label="Loading"
      >
        {spinner}
      </div>
    );
  }

  return (
    <div
      className={`relative flex w-full items-center justify-center ${
        dense ? 'min-h-[160px] py-8' : 'min-h-[min(60vh,480px)] py-12'
      }`}
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      {spinner}
    </div>
  );
}
