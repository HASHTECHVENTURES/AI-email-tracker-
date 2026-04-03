'use client';

export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-blue-50 px-6">
      <p className="text-center text-gray-900">Something went wrong loading this page.</p>
      {process.env.NODE_ENV === 'development' && error?.message ? (
        <p className="mt-2 max-w-md text-center font-mono text-xs text-gray-500">{error.message}</p>
      ) : null}
      <button
        type="button"
        onClick={() => reset()}
        className="mt-6 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
      >
        Try again
      </button>
    </div>
  );
}
