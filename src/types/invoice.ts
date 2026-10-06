export type InvoiceStatus =
  | 'UNPAID'
  | 'PENDING_VERIFICATION'
  | 'PAID'
  | 'REJECTED'
  | 'VOID'
  | 'REFUNDED';

export interface InvoiceLineItem {
  orderItemId?: string;
  name: string;
  sku?: string | null;
  imageUrl?: string | null;
  quantity: number;
  unitPrice: string;
  total: string;
}

export type InvoiceAddress = Record<string, unknown>;

export interface InvoicePayload {
  eventId?: string;
  orderId: string;
  shopId: string;
  shopName?: string | null;
  customerId: string;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  billingAddress?: InvoiceAddress | null;
  shippingAddress?: InvoiceAddress | null;
  shopContactName?: string | null;
  shopContactEmail?: string | null;
  shopContactPhone?: string | null;
  shopAddress?: string | null;
  paymentMethod: string | null;
  paymentGatewayRef?: string | null;
  paymentSlipUrl?: string | null;
  currency?: string;
  subtotal: string;
  taxAmount: string;
  discountAmount: string;
  grandTotal: string;
  lineItems?: InvoiceLineItem[];
}

export interface InvoiceFilters {
  status?: InvoiceStatus;
  shopId?: string;
  shopIds?: string[];
  customerId?: string;
  orderId?: string;
}

export interface PartialInvoiceItemRequest {
  orderItemId: string;
  quantity: number;
}

export interface PartialInvoiceRequest {
  orderId: string;
  items: PartialInvoiceItemRequest[];
  customerName?: string | null;
  customerEmail?: string | null;
  paymentMethod?: string;
}

export interface PaymentCompletedEvent {
  event_id: string;
  event: 'payment.completed';
  version: 'v1';
  timestamp: string;
  producer: string;
  correlation_id: string;
  data: {
    payment_id: string;
    order_id?: string;
    transaction_id: string;
    reservation_id?: string;
    checkout_id: string;
    amount: number;
    currency: string;
    payment_method?: string;
    shop_name?: string;
    customer_name?: string;
    customer_email?: string;
    updatedAt: string;
  };
}

export interface InvoiceVerificationPayload {
  approved: boolean;
  reason?: string;
}

export type RefundMethod = 'BANK_TRANSFER' | 'CREDIT_CARD' | 'SYSTEM_CREDIT';

export interface InvoiceDocument {
  id: string;
  invoiceNumber: string;
  orderId: string;
  orderReference: string | null;
  shopId: string;
  shopName: string | null;
  customerId: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  billingAddress: InvoiceAddress | null;
  shippingAddress: InvoiceAddress | null;
  shopContactName: string | null;
  shopContactEmail: string | null;
  shopContactPhone: string | null;
  shopAddress: string | null;
  subtotal: string;
  deliveryFee: string;
  taxAmount: string;
  discountAmount: string;
  grandTotal: string;
  lineItems: InvoiceLineItem[] | null;
  currency: string;
  paymentMethod: string | null;
  paymentGatewayRef: string | null;
  paymentSlipUrl: string | null;
  status: InvoiceStatus;
  pdfUrl: string | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  rejectionReason: string | null;
  verificationNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}
