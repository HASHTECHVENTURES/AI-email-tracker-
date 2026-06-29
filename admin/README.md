# AI Email Tracker — monorepo layout

| Directory   | Vercel Root Directory | Purpose                          |
|-------------|------------------------|----------------------------------|
| `frontend`  | `frontend`             | Tenant app (CEO / managers / IC) |
| `admin`     | `admin`                | Platform admin (billing, tenants)|
| `backend`   | — (Railway etc.)       | NestJS API                       |

## Vercel setup

1. **Tenant app** — import repo, set Root Directory to `frontend`.
2. **Admin app** — add a second Vercel project from the same repo, set Root Directory to `admin`.

Set `NEXT_PUBLIC_ADMIN_APP_URL` on the **frontend** project to the admin deployment URL.
Set `NEXT_PUBLIC_APP_URL` on the **admin** project to the tenant app URL (optional, for login link).
