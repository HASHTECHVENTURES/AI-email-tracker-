import type { EmployeeRole } from '../modules/common/types';

export interface AuthedRequestUser {
  id: string;
  email: string;
  fullName: string | null;
  companyId: string;
  companyName: string | null;
  role: EmployeeRole;
  /** Set when the user is a HEAD; links them to their department scope */
  departmentId: string | null;
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
