-- Must run in its own migration transaction before any policy references
-- 'PLATFORM_ADMIN'::employee_role (PostgreSQL error 55P04 otherwise).

ALTER TYPE employee_role ADD VALUE IF NOT EXISTS 'PLATFORM_ADMIN';
