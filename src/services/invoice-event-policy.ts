export type FinalInvoicePaymentStatus = 'PAID' | 'COLLECTED';

export const getFinalInvoicePaymentStatus = (
  event: string,
  data: Record<string, unknown>,
): FinalInvoicePaymentStatus | null => {
  if (event === 'order.paid' && data.payment_status === 'PAID') {
    return 'PAID';
  }

  if (
    event === 'payment.collected'
    && String(data.payment_method ?? '').trim().toUpperCase() === 'COD'
  ) {
    return 'COLLECTED';
  }

  return null;
};