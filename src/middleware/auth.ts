import { NextFunction, Request, Response } from 'express';

type UserRole = 'customer' | 'seller' | 'shopAdmin' | 'admin';
const hasLocalShopFallback = (req: Request): boolean =>
  process.env.NODE_ENV === 'development' && Boolean(req.header('x-shop-id'));

const isCustomerInvoicesRoute = (req: Request): boolean => {
  const url = req.originalUrl ?? req.path ?? '';
  return url.includes('/invoices/my-invoices');
};

const getRole = (req: Request): UserRole => {
  const headerRole = req.header('x-user-role') ?? req.header('x-role');
  const normalizedRole = headerRole?.trim().toLowerCase().replace(/[_-]/g, '');

  if (isCustomerInvoicesRoute(req)) {
    return 'customer';
  }

  if (normalizedRole === 'shopadmin' || normalizedRole === 'shopowner') {
    return 'shopAdmin';
  }

  if (normalizedRole === 'customer' || normalizedRole === 'seller' || normalizedRole === 'admin') {
    return normalizedRole;
  }

  // The local auth shim receives shop context from the frontend while the
  // real gateway is responsible for validating the Bearer token in production.
  // Only assume a shop-admin role when the request does not already provide an explicit role.
  if (!headerRole && (req.header('x-shop-id') || hasLocalShopFallback(req))) {
    return 'shopAdmin';
  }

  return 'customer';
};

export const auth = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.header('authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required',
    });
  }

  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
    });
  }

  req.user = {
    id: req.header('x-user-id') ?? 'demo-user-id',
    role: getRole(req),
    customerId: req.header('x-customer-id') ?? 'd2f3c1c4-1234-4d64-8d2e-4e2d6f0b4567',
    shopId: req.header('x-shop-id') ?? undefined,
  };

  return next();
};

export const requireRoles = (...allowedRoles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.user?.role;

    if (!role || !allowedRoles.includes(role)) {
      res.status(403).json({
        success: false,
        message: 'Forbidden: insufficient role permissions',
      });
      return;
    }

    next();
  };
};
