declare global {
  namespace Express {
    interface Request {
      user?: {
        id?: string;
        role?: 'customer' | 'seller' | 'shopAdmin' | 'admin';
        customerId?: string;
        shopId?: string;
        shopIds?: string[];
        token?: string;
      };
    }
  }
}

export {};
