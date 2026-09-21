import { NextFunction, Request, Response } from 'express';
import env from '@/config/env';

export const serviceAuth = (req: Request, res: Response, next: NextFunction) => {
  const key = req.header('x-service-key');

  if (!key || key !== env.SERVICE_API_KEY) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized service request',
    });
  }

  return next();
};
