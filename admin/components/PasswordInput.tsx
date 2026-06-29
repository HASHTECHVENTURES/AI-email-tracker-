'use client';

import { forwardRef, useCallback, useState } from 'react';

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      className={className}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function EyeSlashIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      className={className}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.182 4.182L9.88 9.88"
      />
    </svg>
  );
}

/**
 * Password field with show/hide control.
 * Uses a span (not a second button) for the toggle so a parent &lt;label&gt; only wraps one labelable
 * control (&lt;input&gt;) — avoids React #418 hydration errors from invalid label markup.
 */
export const PasswordInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function PasswordInput({ className = '', ...rest }, ref) {
    const [visible, setVisible] = useState(false);
    const toggle = useCallback(() => setVisible((v) => !v), []);

    const onKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      },
      [toggle],
    );

    return (
      <span className="relative block w-full">
        <input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className={`w-full !pr-11 ${className}`.trim()}
          {...rest}
        />
        <span
          role="button"
          tabIndex={0}
          title={visible ? 'Hide password' : 'Show password'}
          className="absolute bottom-0 right-0 top-0 flex w-11 cursor-pointer items-center justify-center rounded-r-lg border-l border-slate-200 bg-slate-50/90 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          onClick={toggle}
          onKeyDown={onKeyDown}
        >
          {visible ? <EyeSlashIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
        </span>
      </span>
    );
  },
);

PasswordInput.displayName = 'PasswordInput';
