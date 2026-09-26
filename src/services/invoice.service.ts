import crypto from 'crypto';
import { InvoiceLineItem, InvoiceStatus, PartialInvoiceRequest, RefundMethod } from '@/types/invoice';
import invoiceRepository from '@/repositories/invoice.repository';
import orderSnapshotService, { OrderInvoiceSnapshotItem } from '@/services/order-snapshot.service';
import shopLookupService from '@/services/shop-lookup.service';
import pdfGeneratorService from '@/services/pdf-generator.service';
import storageService from '@/services/storage.service';
import logger from '@/utils/logger';

export class AppError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'ConflictError';
  }
}

const normalizeString = (value?: string | null): string => String(value ?? '').trim();

const moneyToMinorUnits = (value: string | number): bigint => {
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new ValidationError(`Invalid monetary value: ${text}`);
  }
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};

const formatMinorUnits = (value: bigint): string =>
  `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;

export const calculateShopSubtotal = (
  items: Array<Pick<OrderInvoiceSnapshotItem, 'unitPrice' | 'quantity'>>,
): string => formatMinorUnits(items.reduce(
  (total, item) => total + moneyToMinorUnits(item.unitPrice) * BigInt(item.quantity),
  0n,
));

const multiplyMoney = (unitPrice: string, quantity: number): string => {
  const cents = moneyToMinorUnits(unitPrice) * BigInt(quantity);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
};

export const validateRequestedQuantity = (orderItemId: string, requestedQuantity: number, orderedQuantity: number): void => {
  if (!Number.isInteger(requestedQuantity) || requestedQuantity <= 0) {
    throw new ValidationError(`Requested quantity for order item ${orderItemId} must be a positive integer`);
  }

  if (requestedQuantity > orderedQuantity) {
    throw new ValidationError(`Requested quantity for order item ${orderItemId} exceeds the ordered quantity`);
  }
};

export const validatePartialInvoiceShopSelection = (shopIds: Set<string>): void => {
  if (shopIds.size !== 1) {
    throw new ValidationError('Partial invoice items must belong to one shop');
  }
};

export const allocateShopTotals = (
  subtotal: string,
  deliveryFee: string,
  discountAmount: string,
  shopSubtotals: Array<{ shopId: string; subtotal: string }>,
) => {
  const totalSubtotal = moneyToMinorUnits(subtotal);
  let remainingDelivery = moneyToMinorUnits(deliveryFee);
  let remainingDiscount = moneyToMinorUnits(discountAmount);

  return shopSubtotals.map((shop, index) => {
    const shopSubtotal = moneyToMinorUnits(shop.subtotal);
    const last = index === shopSubtotals.length - 1;
    const delivery = last || totalSubtotal === 0n
      ? remainingDelivery
      : moneyToMinorUnits(deliveryFee) * shopSubtotal / totalSubtotal;
    const discount = last || totalSubtotal === 0n
      ? remainingDiscount
      : moneyToMinorUnits(discountAmount) * shopSubtotal / totalSubtotal;
    remainingDelivery -= delivery;
    remainingDiscount -= discount;
    const grandTotal = shopSubtotal + delivery - discount;

    return {
      shopId: shop.shopId,
      subtotal: formatMinorUnits(shopSubtotal),
      deliveryFee: formatMinorUnits(delivery),
      discountAmount: formatMinorUnits(discount),
      grandTotal: formatMinorUnits(grandTotal),
    };
  });
};

export const normalizePartialInvoiceRequest = (payload: PartialInvoiceRequest) => ({
  orderId: normalizeString(payload.orderId),
  items: [...(payload.items ?? [])]
    .map((item) => ({
      orderItemId: normalizeString(item?.orderItemId),
      quantity: Number(item?.quantity ?? 0),
    }))
    .sort((left, right) => left.orderItemId.localeCompare(right.orderItemId) || left.quantity - right.quantity),
  customerName: normalizeString(payload.customerName),
  customerEmail: normalizeString(payload.customerEmail).toLowerCase(),
  paymentMethod: normalizeString(payload.paymentMethod).toUpperCase() || 'MANUAL_SLIP',
});

export const validatePartialInvoiceRequest = (payload: PartialInvoiceRequest): void => {
  const normalized = normalizePartialInvoiceRequest(payload);

  if (!normalized.orderId) {
    throw new ValidationError('orderId is required');
  }

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new ValidationError('At least one invoice item is required');
  }

  const seen = new Set<string>();
  for (const item of normalized.items) {
    if (!item.orderItemId) {
      throw new ValidationError('Each orderItemId is required');
    }

    if (seen.has(item.orderItemId)) {
      throw new ValidationError(`Duplicate orderItemId: ${item.orderItemId}`);
    }

    seen.add(item.orderItemId);

    validateRequestedQuantity(item.orderItemId, item.quantity, Number.MAX_SAFE_INTEGER);
  }
};

export const buildPartialInvoiceRequestHash = (payload: PartialInvoiceRequest): string => {
  const normalized = normalizePartialInvoiceRequest(payload);
  const canonical = {
    orderId: normalized.orderId,
    items: normalized.items.map((item) => ({
      orderItemId: item.orderItemId,
      quantity: item.quantity,
    })),
    customerName: normalized.customerName,
    customerEmail: normalized.customerEmail,
    paymentMethod: normalized.paymentMethod,
  };

  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
};

export const resolveInvoiceDisplayData = ({
  snapshotCustomerName,
  payloadCustomerName,
  snapshotCustomerEmail,
  payloadCustomerEmail,
  snapshotShopName,
  payloadShopName,
  resolvedShopName,
}: {
  snapshotCustomerName?: string | null;
  payloadCustomerName?: string | null;
  snapshotCustomerEmail?: string | null;
  payloadCustomerEmail?: string | null;
  snapshotShopName?: string | null;
  payloadShopName?: string | null;
  resolvedShopName?: string | null;
}) => ({
  customerName: normalizeString(snapshotCustomerName || payloadCustomerName) || null,
  customerEmail: normalizeString(snapshotCustomerEmail || payloadCustomerEmail).toLowerCase() || null,
  shopName: normalizeString(resolvedShopName || snapshotShopName || payloadShopName) || null,
});

export const resolveInvoiceShopNames = async (
  shopIds: string[],
  lookup: (shopId: string) => Promise<string | null> = (shopId) => shopLookupService.getShopName(shopId),
): Promise<Map<string, string | null>> => {
  const uniqueShopIds = [...new Set(shopIds.map((shopId) => shopId.trim()).filter(Boolean))];
  const resolvedEntries = await Promise.all(uniqueShopIds.map(async (shopId) => [
    shopId,
    await lookup(shopId),
  ] as const));

  return new Map(resolvedEntries);
};

export const populateMissingInvoiceShopNames = async <T extends {
  shopId: string;
  shopName: string | null;
}>(
  invoices: T[],
  lookup: (shopId: string) => Promise<string | null> = (shopId) => shopLookupService.getShopName(shopId),
): Promise<T[]> => {
  const missingShopIds = invoices
    .filter((invoice) => !normalizeString(invoice.shopName))
    .map((invoice) => invoice.shopId);
  const namesByShopId = await resolveInvoiceShopNames(missingShopIds, lookup);

  return invoices.map((invoice) => {
    if (normalizeString(invoice.shopName)) {
      return invoice;
    }

    return {
      ...invoice,
      shopName: namesByShopId.get(invoice.shopId) ?? null,
    };
  });
};

export class InvoiceService {
  async createPartialInvoice(payload: PartialInvoiceRequest, customerId: string, idempotencyKey: string) {
    const trimmedIdempotencyKey = idempotencyKey?.trim() ?? '';
    if (!trimmedIdempotencyKey) {
      throw new ValidationError('Idempotency-Key header is required');
    }

    const normalizedRequest = normalizePartialInvoiceRequest(payload);
    validatePartialInvoiceRequest(normalizedRequest);

    if (!customerId?.trim()) {
      throw new ForbiddenError('Customer authorization required');
    }

    const requestHash = buildPartialInvoiceRequestHash(normalizedRequest);
    const existing = await invoiceRepository.findIdempotency(trimmedIdempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictError('Idempotency key was used with a different request');
      }
      return existing.invoice;
    }

    const snapshot = await orderSnapshotService.getInvoiceSnapshot(normalizedRequest.orderId);
    if (snapshot.orderId !== normalizedRequest.orderId) {
      throw new NotFoundError('Order snapshot does not match the requested order');
    }

    const currency = snapshot.currency?.trim().toUpperCase();
    if (!currency) {
      throw new ValidationError('Order snapshot currency is required');
    }

    const snapshotItems = new Map<string, OrderInvoiceSnapshotItem>();
    for (const item of snapshot.items) {
      if (
        !item.orderItemId || !item.productId || !item.productName?.trim()
        || !item.shopId || !Number.isInteger(item.quantity) || item.quantity <= 0
        || !/^\d+(\.\d{1,2})?$/.test(item.unitPrice)
      ) {
        throw new ValidationError('Order snapshot contains an invalid item');
      }

      if (snapshotItems.has(item.orderItemId)) {
        throw new ValidationError('Order snapshot contains duplicate order items');
      }

      snapshotItems.set(item.orderItemId, item);
    }

    const selectedItems: Array<OrderInvoiceSnapshotItem & { requestedQuantity: number }> = [];
    const requestedIds = new Set<string>();
    const shopIds = new Set<string>();

    for (const requested of normalizedRequest.items) {
      const snapshotItem = snapshotItems.get(requested.orderItemId);
      if (!snapshotItem) {
        throw new NotFoundError(`Order item ${requested.orderItemId} was not found in the snapshot`);
      }

      if (requestedIds.has(requested.orderItemId)) {
        throw new ValidationError(`Duplicate orderItemId: ${requested.orderItemId}`);
      }

      validateRequestedQuantity(requested.orderItemId, requested.quantity, snapshotItem.quantity);
      requestedIds.add(requested.orderItemId);
      shopIds.add(snapshotItem.shopId as string);
      selectedItems.push({ ...snapshotItem, requestedQuantity: requested.quantity });
    }

    validatePartialInvoiceShopSelection(shopIds);

    const shopId = [...shopIds][0];
    const subtotal = selectedItems
      .reduce((total, item) => total + Number(item.unitPrice) * item.requestedQuantity, 0)
      .toFixed(2);
    const taxAmount = '0.00';
    const discountAmount = '0.00';
    const grandTotal = subtotal;

    if (!Number.isFinite(Number(subtotal)) || Number(subtotal) < 0) {
      throw new ValidationError('Partial invoice subtotal is invalid');
    }

    return invoiceRepository.createPartialInvoice({
      invoiceNumber: this.generateInvoiceNumber(),
      orderId: normalizedRequest.orderId,
      shopId,
      customerId,
      customerName: normalizedRequest.customerName || null,
      customerEmail: normalizedRequest.customerEmail || null,
      currency,
      paymentMethod: normalizedRequest.paymentMethod,
      subtotal,
      taxAmount,
      discountAmount,
      grandTotal,
      items: selectedItems,
      idempotencyKey: trimmedIdempotencyKey,
      requestHash,
    });
  }

  async createInvoiceFromPayment(payload: {
    paymentId: string;
    orderId: string;
    transactionId: string;
    amount: number;
    currency: string;
    paymentMethod?: string | null;
    customerName?: string | null;
    customerEmail?: string | null;
    shopName?: string | null;
  }) {
    const snapshot = await orderSnapshotService.getInvoiceSnapshot(payload.orderId);
    if (snapshot.orderId !== payload.orderId) {
      throw new ValidationError('Order snapshot does not match the payment order');
    }

    if (moneyToMinorUnits(payload.amount) !== moneyToMinorUnits(snapshot.grandTotal)) {
      throw new ValidationError(`Payment amount does not match order grand total for ${payload.orderId}`);
    }

    const snapshotCurrency = snapshot.currency?.trim().toUpperCase();
    const paymentCurrency = payload.currency.trim().toUpperCase();
    if (snapshotCurrency && snapshotCurrency !== paymentCurrency) {
      throw new ValidationError(`Payment currency does not match order currency for ${payload.orderId}`);
    }

    if (!snapshot.customerId.trim() || !payload.paymentId.trim() || !payload.transactionId.trim()) {
      throw new ValidationError('Payment identity and snapshot customer ID are required');
    }

    const currency = snapshotCurrency || paymentCurrency;
    const itemsByShop = new Map<string, OrderInvoiceSnapshotItem[]>();
    for (const item of snapshot.items) {
      const shopId = item.shopId?.trim();
      if (!shopId) {
        throw new ValidationError('Order snapshot does not contain a shop ID');
      }
      const items = itemsByShop.get(shopId) ?? [];
      items.push(item);
      itemsByShop.set(shopId, items);
    }

    const shops = [...itemsByShop.entries()];
    const shopNames = await resolveInvoiceShopNames(shops.map(([shopId]) => shopId));
    const shopTotals = allocateShopTotals(
      snapshot.subtotal,
      snapshot.deliveryFee,
      snapshot.promotionDiscountTotal,
      shops.map(([shopId, items]) => ({
        shopId,
        subtotal: calculateShopSubtotal(items),
      })),
    );
    const invoices = [];

    for (let index = 0; index < shops.length; index += 1) {
      const [shopId, items] = shops[index];
      const shopTotal = shopTotals[index];
      const snapshotShopName = items.find((item) => item.shopName?.trim())?.shopName;
      const resolvedShopName = shopNames.get(shopId) ?? null;
      const displayData = resolveInvoiceDisplayData({
        snapshotCustomerName: snapshot.customerName,
        payloadCustomerName: payload.customerName,
        snapshotCustomerEmail: snapshot.customerEmail,
        payloadCustomerEmail: payload.customerEmail,
        snapshotShopName,
        payloadShopName: payload.shopName,
        resolvedShopName,
      });
      const shopName = displayData.shopName;
      const invoiceItems = items.map((item) => ({
        ...item,
        lineTotal: multiplyMoney(item.unitPrice, item.quantity),
        requestedQuantity: item.quantity,
      }));
      const lineItems: InvoiceLineItem[] = invoiceItems.map((item) => ({
        name: item.productName?.trim() || item.productSku || item.productId,
        quantity: item.requestedQuantity,
        unitPrice: item.unitPrice,
        total: item.lineTotal,
      }));
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({
        paymentId: payload.paymentId,
        orderId: snapshot.orderId,
        shopId,
        transactionId: payload.transactionId,
        amount: shopTotal.grandTotal,
        currency,
        items: invoiceItems.map((item) => [item.orderItemId, item.requestedQuantity]),
      })).digest('hex');
      const idempotencyKey = shops.length === 1
        ? `payment:${payload.paymentId}`
        : `payment:${payload.paymentId}:shop:${shopId}`;

      const invoice = await invoiceRepository.createPaidInvoiceFromPayment({
        invoiceNumber: this.generateInvoiceNumber(),
        orderId: snapshot.orderId,
        shopId,
        shopName: normalizeString(shopName) || null,
        customerId: snapshot.customerId,
        customerName: displayData.customerName,
        customerEmail: displayData.customerEmail,
        currency,
        subtotal: shopTotal.subtotal,
        deliveryFee: shopTotal.deliveryFee,
        taxAmount: '0.00',
        discountAmount: shopTotal.discountAmount,
        grandTotal: shopTotal.grandTotal,
        paymentMethod: normalizeString(payload.paymentMethod).toUpperCase() || null,
        paymentGatewayRef: payload.transactionId,
        lineItems,
        items: invoiceItems,
        idempotencyKey,
        requestHash,
      });

      invoices.push(invoice);
      void this.generatePdfAsync(invoice.id, invoice);
    }

    return invoices.length === 1 ? invoices[0] : invoices;
  }

  async verifyInvoice(id: string, approved: boolean, verifiedBy: string, rejectionReason?: string, shopId?: string) {
    const invoice = await invoiceRepository.findById(id);

    if (!invoice) {
      throw new NotFoundError('Invoice not found');
    }

    if (shopId && invoice.shopId !== shopId) {
      throw new ForbiddenError('Invoice does not belong to the active shop');
    }

    const allowedStatuses: InvoiceStatus[] = ['PENDING_VERIFICATION'];
    if (!allowedStatuses.includes(invoice.status)) {
      throw new ConflictError(`Invoice cannot be verified while in ${invoice.status} status`);
    }

    if (approved) {
      const updatedInvoice = await invoiceRepository.transitionVerification(id, true, verifiedBy, rejectionReason);
      if (!updatedInvoice) {
        throw new ConflictError('Invoice has already been verified');
      }

      void this.generatePdfAsync(updatedInvoice.id, updatedInvoice);
      return updatedInvoice;
    }

    const updatedInvoice = await invoiceRepository.transitionVerification(id, false, verifiedBy, rejectionReason);
    if (!updatedInvoice) {
      throw new ConflictError('Invoice has already been verified');
    }
    return updatedInvoice;
  }

  async voidInvoice(id: string, voidedBy: string, reason: string) {
    const invoice = await invoiceRepository.findById(id);

    if (!invoice) {
      throw new Error('Invoice not found');
    }

    if (invoice.status === 'VOID' || invoice.status === 'REFUNDED') {
      throw new Error(`Invoice cannot be voided while in ${invoice.status} status`);
    }

    return invoiceRepository.updateStatus(id, {
      status: 'VOID',
      verifiedBy: voidedBy,
      verifiedAt: new Date(),
      rejectionReason: reason,
    });
  }

  async refundInvoice(
    id: string,
    refundedBy: string,
    amount: string,
    method: RefundMethod,
    reason: string,
  ) {
    const invoice = await invoiceRepository.findById(id);

    if (!invoice) {
      throw new Error('Invoice not found');
    }

    if (invoice.status !== 'PAID') {
      throw new Error(`Invoice can only be refunded while in PAID status`);
    }

    if (Number(amount) <= 0 || Number(amount) > Number(invoice.grandTotal)) {
      throw new Error('Refund amount must be greater than zero and no more than the invoice total');
    }

    return invoiceRepository.updateStatus(id, {
      status: 'REFUNDED',
      verifiedBy: refundedBy,
      verifiedAt: new Date(),
      refundAmount: amount,
      refundMethod: method,
      refundReason: reason,
    });
  }

  async getInvoicesByCustomer(customerId: string) {
    return invoiceRepository.listInvoices({ customerId });
  }

  async getInvoicesByShop(shopId: string, status?: InvoiceStatus) {
    return invoiceRepository.listInvoices({ shopId, status });
  }

  async getAllInvoices(status?: InvoiceStatus) {
    const invoices = await invoiceRepository.listInvoices({ status });
    return populateMissingInvoiceShopNames(invoices);
  }

  async getInvoiceById(id: string) {
    return invoiceRepository.findById(id);
  }

  async uploadPaymentSlip(id: string, customerId: string, paymentSlipDataUrl: string) {
    const invoice = await invoiceRepository.findById(id);
    if (!invoice) throw new Error('Invoice not found');
    if (invoice.customerId !== customerId) throw new Error('Invoice does not belong to this customer');
    if (!['UNPAID', 'REJECTED'].includes(invoice.status)) {
      throw new Error(`Invoice cannot accept a payment slip while in ${invoice.status} status`);
    }
    const paymentSlipUrl = await storageService.uploadImageDataUrl(id, paymentSlipDataUrl);
    return invoiceRepository.updatePaymentSlip(id, paymentSlipUrl);
  }

  async updateOrderSnapshot(payload: {
    orderId: string;
    shopName?: string | null;
    lineItems?: InvoiceLineItem[];
    customerName?: string | null;
    customerEmail?: string | null;
  }) {
    const invoice = await invoiceRepository.findByOrderId(payload.orderId);
    if (!invoice) return null;
    return invoiceRepository.updateOrderSnapshot(payload.orderId, payload);
  }

  async generateInvoicePdf(id: string, shopId?: string) {
    const invoice = await invoiceRepository.findById(id);

    if (!invoice) {
      throw new Error('Invoice not found');
    }
    if (shopId && invoice.shopId !== shopId) {
      throw new ForbiddenError('Invoice does not belong to the active shop');
    }

    await this.generatePdfAsync(invoice.id, invoice);
    return invoiceRepository.findById(id);
  }

  async generateInvoicePdfBatch(invoiceIds: string[], shopId?: string) {
    const uniqueIds = [...new Set(invoiceIds.filter((id) => typeof id === 'string' && id.trim().length > 0))];
    const generated: Awaited<ReturnType<typeof invoiceRepository.findById>>[] = [];

    for (const invoiceId of uniqueIds) {
      const invoice = await invoiceRepository.findById(invoiceId);
      if (!invoice) {
        continue;
      }
      if (shopId && invoice.shopId !== shopId) {
        throw new ForbiddenError('Invoice does not belong to the active shop');
      }

      await this.generatePdfAsync(invoice.id, invoice);
      const refreshedInvoice = await invoiceRepository.findById(invoice.id);
      if (refreshedInvoice) {
        generated.push(refreshedInvoice);
      }
    }

    return generated;
  }

  async buildBatchPdfArchive(invoiceIds: string[], shopId?: string) {
    const uniqueIds = [...new Set(invoiceIds.filter((id) => typeof id === 'string' && id.trim().length > 0))];
    const entries: Array<{ name: string; buffer: Buffer }> = [];

    for (const invoiceId of uniqueIds) {
      const invoice = await invoiceRepository.findById(invoiceId);
      if (!invoice) {
        continue;
      }
      if (shopId && invoice.shopId !== shopId) {
        throw new ForbiddenError('Invoice does not belong to the active shop');
      }

      let pdfUrl = invoice.pdfUrl;
      if (!pdfUrl) {
        await this.generatePdfAsync(invoice.id, invoice);
        const refreshedInvoice = await invoiceRepository.findById(invoice.id);
        pdfUrl = refreshedInvoice?.pdfUrl ?? null;
      }

      if (!pdfUrl) {
        continue;
      }

      const pdfBuffer = await storageService.downloadPdf(pdfUrl);
      entries.push({
        name: `${invoice.invoiceNumber || invoice.id}.pdf`,
        buffer: pdfBuffer,
      });
    }

    return entries;
  }

  private async generatePdfAsync(
    invoiceId: string,
    invoice: {
      id: string;
      invoiceNumber: string;
      orderId: string;
      shopId: string;
      shopName?: string | null;
      customerId: string;
      customerName?: string | null;
      customerEmail?: string | null;
      subtotal: string | { toString(): string };
      taxAmount: string | { toString(): string };
      deliveryFee?: string | { toString(): string };
      discountAmount: string | { toString(): string };
      grandTotal: string | { toString(): string };
      currency: string;
      paymentMethod: string | null;
      status: InvoiceStatus;
      createdAt: Date;
      lineItems?: unknown;
      pdfUrl?: string | null;
    }
  ) {
    if (invoice.pdfUrl || !(await invoiceRepository.claimPdfGeneration(invoiceId))) {
      return;
    }

    try {
      const pdfUrl = await pdfGeneratorService.buildAndUploadInvoicePdf({
        invoiceNumber: invoice.invoiceNumber,
        orderId: invoice.orderId,
        shopId: invoice.shopId,
        customerId: invoice.customerId,
        shopName: invoice.shopName,
        customerName: invoice.customerName,
        customerEmail: invoice.customerEmail,
        currency: invoice.currency,
        subtotal: invoice.subtotal.toString(),
        taxAmount: invoice.taxAmount.toString(),
        deliveryFee: invoice.deliveryFee?.toString() ?? '0.00',
        discountAmount: invoice.discountAmount.toString(),
        grandTotal: invoice.grandTotal.toString(),
        lineItems: this.normalizeLineItems(invoice.lineItems),
        paymentMethod: invoice.paymentMethod,
        status: invoice.status,
        createdAt: invoice.createdAt,
      });

      await invoiceRepository.markPdfReady(invoiceId, pdfUrl);
    } catch (error) {
      await invoiceRepository.markPdfFailed(invoiceId, error instanceof Error ? error.message : 'PDF generation failed');
      logger.error(`Failed to generate invoice PDF for ${invoiceId}`, error as Error);
    }
  }

  private generateInvoiceNumber(): string {
    const date = new Date();
    const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    const randomSequence = Math.floor(10000 + Math.random() * 90000);
    return `INV-${stamp}-${String(randomSequence)}`;
  }

  private normalizeLineItems(value: unknown): InvoiceLineItem[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is InvoiceLineItem => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<InvoiceLineItem>;
      return typeof candidate.name === 'string'
        && typeof candidate.quantity === 'number'
        && typeof candidate.unitPrice === 'string'
        && typeof candidate.total === 'string';
    });
  }
}

export default new InvoiceService();
