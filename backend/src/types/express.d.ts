import type { EmployeeRole } from '../modules/common/types';

export interface AuthedRequestUser {
  id: string;
  email: string;
  fullName: string | null;
  companyId: string;
  companyName: string | null;
  role: EmployeeRole;
  /**
   * Default department for HEAD (legacy `users.department_id` when in managed set, else first managed).
   * Active scope may be overridden per request via `x-manager-department-id` (see getRequestContext).
   */
  departmentId: string | null;
  /** HEAD: all department IDs this user may manage (memberships + legacy profile). Empty for other roles. */
  managedDepartmentIds: string[];
  /** Tracked employee row for EMPLOYEE role (dashboard scope) */
  linkedEmployeeId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      /** Populated by AppAuthGuard after JWT + users row lookup */
      user?: AuthedRequestUser;
      /** Set when request authenticates with INTERNAL_API_KEY */
      internalApiAuth?: boolean;
      /** JWT subject when profile is not required yet (onboarding) */
      jwtSub?: string;
      jwtEmail?: string;
    }
  }
}

export {};
