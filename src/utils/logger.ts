import winston, { Logform } from 'winston';
import env from '@/config/env';

const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize({ all: true }),
    winston.format.printf((info: Logform.TransformableInfo) => {
      const { timestamp, level, message, ...meta } = info;
      const metaString = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${String(timestamp)} ${String(level)}: ${String(message)}${metaString}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

export default logger;
