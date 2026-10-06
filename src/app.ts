import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import routes from '@/routes';
import { errorHandler } from '@/middleware/errorHandler';
import env from '@/config/env';

const app: Express = express();

app.use(helmet());

app.use(
  cors({
    // Accepts a comma-separated list so the browser origin and the headless
    // PDF renderer's origin can both be allowed.
    origin: env.CORS_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    credentials: true,
  })
);

app.use((req, res, next) => {
  if (req.originalUrl === '/api/v1/webhooks/payment') {
    return next();
  }
  return express.json({ limit: '10mb' })(req, res, next);
});

app.use((req, res, next) => {
  if (req.originalUrl === '/api/v1/webhooks/payment') {
    return next();
  }
  return express.urlencoded({ extended: true })(req, res, next);
});

if (env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

app.use('/api/v1', routes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

app.use(errorHandler);

export default app;
