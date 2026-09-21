import { NextFunction, Request, Response } from 'express';
import { AppError } from '@/services/invoice.service';
import logger from '@/utils/logger';

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const message = err.message || 'Internal server error';

  logger.error(`Request failed with status ${statusCode}`, err);

  res.status(statusCode).json({
    success: false,
    message,
  });
};
