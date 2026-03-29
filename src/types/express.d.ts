import { User, Organization } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      user?: User & { organization?: Organization | null };
      organizationId?: string;
      sessionToken?: string;
      sessionExpiresAt?: Date;
    }
  }
}

export {};
