/**
 * Auth / API roles align with the backend (`EmployeeRole` in Nest).
 * Department managers are **`HEAD`** only — there is no separate `MANAGER` enum in API responses.
 * UI copy may say “Manager”; use this helper for permission checks.
 */
export function isDepartmentManagerRole(role: string | undefined | null): boolean {
  return role === 'HEAD';
}
