import jwt, { JwtPayload } from 'jsonwebtoken';
import { NextFunction, Request, Response } from 'express';
import env from '@/config/env';

type UserRole = 'customer' | 'seller' | 'shopAdmin' | 'admin';

type AccessContext = {
  platform_roles?: Array<{ code?: string }>;
  active_shop?: {
    shop_id?: string;
    role?: { code?: string } | null;
  } | null;
  shops?: Array<{
    shop_id?: string;
    membership_status?: string;
    role?: { code?: string } | null;
  }>;
};

type AuthenticatedClaims = JwtPayload & {
  role?: string;
};

export const parseAccessContextResponse = (body: unknown): AccessContext | null => {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return null;
  }

  const nestedContext = (data as { access_context?: unknown }).access_context;
  const context = nestedContext && typeof nestedContext === 'object'
    ? nestedContext
    : data;

  return Array.isArray((context as AccessContext).shops)
    ? context as AccessContext
    : null;
};

const normalizeRole = (role?: string): string =>
  role?.trim().toLowerCase().replace(/[-\s]/g, '_') ?? '';

const roleFromClaims = (claims: AuthenticatedClaims): UserRole | undefined => {
  const role = normalizeRole(claims.role);
  if (['admin', 'super_admin', 'platform_super_admin', 'superadmin'].includes(role)) {
    return 'admin';
  }
  return undefined;
};

const getAccessContext = async (token: string): Promise<AccessContext> => {
  const response = await fetch(`${env.AUTH_SERVICE_URL.replace(/\/+$/, '')}/api/v1/me/access-context`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  });

  if (!response.ok) {
    throw new Error('Unable to verify authorization context');
  }

  const context = parseAccessContextResponse(await response.json());
  if (!context) {
    throw new Error('Authorization context is missing');
  }
  return context;
};

const getShopMembership = (context: AccessContext, shopId: string) =>
  context.shops?.find((shop) => shop.shop_id === shopId && shop.membership_status === 'active');

export const auth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.header('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ success: false, message: 'Invalid token' });
    return;
  }

  if (!env.JWT_SECRET) {
    res.status(503).json({ success: false, message: 'Invoice authentication is not configured' });
    return;
  }

  try {
    const claims = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as AuthenticatedClaims;
    if (typeof claims.sub !== 'string' || !claims.sub.trim()) {
      res.status(401).json({ success: false, message: 'Authenticated user ID is missing' });
      return;
    }

    const platformRole = roleFromClaims(claims);
    const requestedShopId = req.header('x-shop-id')?.trim();
    const isCustomerRoute = (req.originalUrl ?? req.path).includes('/invoices/my-invoices');

    if (platformRole) {
      req.user = { id: claims.sub, customerId: claims.sub, role: platformRole, shopId: requestedShopId, token };
      next();
      return;
    }

    const context = await getAccessContext(token);
    if (isCustomerRoute) {
      req.user = { id: claims.sub, customerId: claims.sub, role: 'customer', token };
      next();
      return;
    }

    const shopId = requestedShopId || context.active_shop?.shop_id;
    const membership = shopId ? getShopMembership(context, shopId) : undefined;
    if (!membership) {
      res.status(403).json({ success: false, message: 'User is not assigned to the requested shop' });
      return;
    }

    req.user = { id: claims.sub, customerId: claims.sub, role: 'shopAdmin', shopId, token };
    next();
  } catch (error) {
    const message = error instanceof jwt.TokenExpiredError ? 'Token expired' : 'Invalid authentication token';
    res.status(401).json({ success: false, message });
  }
};

export const requireRoles = (...allowedRoles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user?.role || !allowedRoles.includes(req.user.role)) {
      res.status(403).json({ success: false, message: 'Forbidden: insufficient role permissions' });
      return;
    }
    next();
  };
};
