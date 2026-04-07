'use client';

import { useEffect, useState } from 'react';

function prettyFirstName(fullName: string | null | undefined, email: string): string {
  const raw = (fullName?.trim().split(/\s+/)[0] || email.split('@')[0] || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 22) return 'Good evening';
  return 'Good night';
}

type TimeGreetingProps = {
  fullName: string | null;
  email: string;
};

/** Local-time greeting above the dashboard title, e.g. “Good afternoon, Sujal”. */
export function TimeGreeting({ fullName, email }: TimeGreetingProps) {
  const [line, setLine] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      const name = prettyFirstName(fullName, email);
      const g = greetingForHour(new Date().getHours());
      setLine(name ? `${g}, ${name}` : g);
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [fullName, email]);

  if (!line) return null;

  return <p className="mb-1 text-sm font-semibold tracking-tight text-indigo-700">{line}</p>;
}
