export interface InvoiceAccessActor {
  id?: string;
  customerId?: string;
  role?: string;
  shopId?: string;
  shopIds?: string[];
}

export interface InvoiceAccessResource {
  customerId: string;
  shopId: string;
}

export const canAccessInvoice = (
  invoice: InvoiceAccessResource,
  actor: InvoiceAccessActor,
): boolean => {
  if (actor.role === 'admin') return true;
  if (actor.customerId && actor.customerId === invoice.customerId) return true;
  return Boolean(
    (actor.shopId && actor.shopId === invoice.shopId)
    || actor.shopIds?.includes(invoice.shopId),
  );
};
