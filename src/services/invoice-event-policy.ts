export type FinalInvoicePaymentStatus = 'PAID' | 'UNPAID' | 'COLLECTED';

const normalizeEventValue = (value: unknown): string =>
  String(value ?? '').trim().toUpperCase();

export const getFinalInvoicePaymentStatus = (
  event: string,
  data: Record<string, unknown>,
): FinalInvoicePaymentStatus | null => {
  if (event === 'order.paid' && data.payment_status === 'PAID') {
    return 'PAID';
  }

  if (event === 'order.paid' && data.payment_status === 'COD') {
    return 'UNPAID';
  }

  if (
    event === 'payment.collected'
    && normalizeEventValue(data.payment_method) === 'COD'
  ) {
    return 'COLLECTED';
  }

  return null;
};