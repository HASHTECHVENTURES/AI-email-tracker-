'use client';

import Link from 'next/link';
import styles from './portal.module.css';

const ROLE_CARDS = [
  {
    id: 'ceo',
    title: 'CEO',
    subtitle: 'Owner/Admin',
    description:
      'Create a new workspace, invite your team, and monitor company-wide follow-ups.',
    cta: 'Continue as CEO',
  },
  {
    id: 'manager',
    title: 'Manager',
    subtitle: 'Department Lead',
    description:
      'Sign in to manage team follow-ups, review escalations, and coordinate responses.',
    cta: 'Continue as Manager',
  },
  {
    id: 'employee',
    title: 'Employee',
    subtitle: 'Mailbox User',
    description:
      'Sign in to track your conversations, connect Gmail, and close follow-up loops.',
    cta: 'Continue as Employee',
  },
] as const;

export default function PortalPage() {
  return (
    <main className={styles.page}>
      <div className={styles.bgGlow} />
      <div className={styles.container}>
        <div className={styles.header}>
          <p className={styles.eyebrow}>Portal v1</p>
          <h1 className={styles.title}>Choose your portal</h1>
          <p className={styles.subtitle}>
            Select your role to continue to the correct login/account experience.
          </p>
        </div>

        <section className={styles.grid}>
          {ROLE_CARDS.map((role) => (
            <article key={role.id} className={styles.card}>
              <div className={styles.badgeRow}>
                <span className={styles.badge}>{role.subtitle}</span>
                <span className={styles.dot} />
              </div>
              <div className={styles.cardTop}>
                <h2 className={styles.cardTitle}>{role.title}</h2>
              </div>
              <p className={styles.description}>{role.description}</p>
              <Link
                href={`/auth?portal=${role.id}`}
                className={styles.cta}
              >
                {role.cta}
              </Link>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
