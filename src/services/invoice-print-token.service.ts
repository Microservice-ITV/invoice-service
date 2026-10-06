import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import env from '@/config/env';
import logger from '@/utils/logger';

/** Print tokens are deliberately short-lived and bound to a single invoice. */
const PRINT_TOKEN_TTL_SECONDS = 120;

export interface PrintTokenClaims {
  sub: string;
  invoiceId: string;
  invoiceNumber: string;
  role: string;
  shopId?: string;
}

/**
 * Issues a short-lived, single-invoice token for the headless PDF renderer.
 *
 * The token is signed with the service's existing JWT secret, expires in ~2
 * minutes and is only accepted for the invoice it was issued for. It is not a
 * permanent or public token: `/invoices/print/:invoiceNumber` re-verifies the
 * signature, the expiry and the invoice's ownership before returning any data.
 */
class InvoicePrintTokenService {
  issue(claims: PrintTokenClaims): string {
    if (!env.JWT_SECRET) {
      throw new Error('JWT_SECRET is required to issue invoice print tokens');
    }

    return jwt.sign(
      { scope: 'invoice:print', ...claims },
      env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: PRINT_TOKEN_TTL_SECONDS },
    );
  }

  verify(token: string | undefined, invoiceNumber: string): PrintTokenClaims {
    if (!env.JWT_SECRET) {
      throw new Error('JWT_SECRET is required to verify invoice print tokens');
    }
    if (!token) {
      throw new Error('Print token is required');
    }

    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
    }) as (PrintTokenClaims & { scope?: string }) | undefined;

    if (!decoded || decoded.scope !== 'invoice:print' || !decoded.invoiceId) {
      throw new Error('Invalid print token');
    }
    if (decoded.invoiceNumber !== invoiceNumber) {
      throw new Error('Print token does not match this invoice');
    }

    return decoded;
  }
}

export const invoicePrintTokenService = new InvoicePrintTokenService();
export default invoicePrintTokenService;

/** Short random nonce, useful for correlating PDF renders in logs. */
export const createRenderTraceId = (): string => crypto.randomBytes(6).toString('hex');

export const logPrintRender = (message: string, traceId: string): void => {
  logger.info(`[invoice-pdf:${traceId}] ${message}`);
};