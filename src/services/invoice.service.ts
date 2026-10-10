import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { InvoiceLineItem, InvoiceStatus, PartialInvoiceRequest, RefundMethod } from '@/types/invoice';
import invoiceRepository from '@/repositories/invoice.repository';
import orderSnapshotService, {
  OrderInvoiceSnapshot,
  InvoiceSnapshotAddress,
  OrderInvoiceSnapshotItem,
  OrderSnapshotError,
} from '@/services/order-snapshot.service';
import shopLookupService from '@/services/shop-lookup.service';
import pdfGeneratorService from '@/services/pdf-generator.service';
import storageService from '@/services/storage.service';
import invoiceNotificationPublisher, {
  type InvoiceNotificationType,
} from '@/rabbitmq/publishers/invoice-notification.publisher';
import { canAccessInvoice, InvoiceAccessActor } from '@/services/invoice-access-policy';
import { getFinalInvoicePaymentStatus } from '@/services/invoice-event-policy';
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

export const MAX_INVOICE_REPLAY_ORDER_IDS = 50;

export type InvoiceReplayResult = {
  orderId: string;
  status: 'CREATED' | 'ALREADY_EXISTS' | 'INELIGIBLE' | 'FAILED';
  reason?: string;
};

export type InvoiceReplaySummary = {
  total: number;
  created: number;
  skipped_existing: number;
  skipped_ineligible: number;
  failed: number;
  results: InvoiceReplayResult[];
};

export type MissingInvoiceShop = {
  shopId: string;
  shopName: string | null;
  expectedInvoiceStatus: 'PAID' | 'UNPAID';
  subtotal: string;
  deliveryFee: string;
  discountAmount: string;
  grandTotal: string;
  reason: 'NO_INVOICE_FOR_SHOP';
};

export type MissingInvoiceOrder = {
  orderId: string;
  customerId: string;
  customerName: string | null;
  paymentStatus: string;
  paymentMethod: string | null;
  currency: string | null;
  createdAt: string;
  missingShops: MissingInvoiceShop[];
};

export type MissingInvoicePage = {
  data: MissingInvoiceOrder[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type MissingInvoiceReplayResult = {
  orderId: string;
  shopId: string;
  status: 'CREATED' | 'ALREADY_EXISTS' | 'INELIGIBLE' | 'FAILED';
  reason?: string;
};

export type MissingInvoiceReplaySummary = {
  total: number;
  created: number;
  skipped_existing: number;
  skipped_ineligible: number;
  failed: number;
  hasMore: boolean;
  nextCursor: string | null;
  results: MissingInvoiceReplayResult[];
};

const MISSING_INVOICE_PAGE_SIZE = 50;
const MAX_MISSING_INVOICE_REPLAYS_PER_REQUEST = 50;
const MAX_CANDIDATES_PER_REPLAY_REQUEST = 500;

type SnapshotInvoiceCreation = {
  paymentStatus: 'PAID' | 'UNPAID';
  paymentMethod?: string | null;
  currency: string;
  customerName?: string | null;
  customerEmail?: string | null;
  shopName?: string | null;
  idempotencyKeyBase: string;
  paymentId?: string | null;
  transactionId?: string | null;
  onlyShopId?: string;
};

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'ConflictError';
  }
}

const normalizeString = (value?: string | null): string => String(value ?? '').trim();

const normalizePhoneNumber = (value?: string | null): string =>
  String(value ?? '').replace(/\D/g, '');

const getAddressValue = (
  address: InvoiceSnapshotAddress | null | undefined,
  keys: string[],
): string | null => {
  for (const key of keys) {
    const value = address?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
};

const getSnapshotCustomerPhone = (snapshot: OrderInvoiceSnapshot): string | null =>
  normalizeString(snapshot.customerPhone)
  || getAddressValue(snapshot.shippingAddress, [
    'phone_no',
    'phone',
    'phone_number',
    'recipient_phone',
  ])
  || null;

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toPrismaJsonValue);
  }
  if (typeof value === 'object') {
    return toPrismaJsonObject(value);
  }
  throw new TypeError('Invoice address contains a non-JSON value');
}

function toPrismaJsonObject(value: object): Prisma.InputJsonObject {
  const entries = Object.entries(value).map(([key, entry]) => [key, toPrismaJsonValue(entry)] as const);
  return Object.fromEntries(entries);
}

const toPrismaJsonAddress = (
  address: InvoiceSnapshotAddress | null | undefined,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput =>
  address == null ? Prisma.DbNull : toPrismaJsonObject(address);

const normalizePdfAddress = (
  value: Prisma.JsonValue | undefined,
): Record<string, unknown> | null => {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value;
};

/**
 * Invoices are always issued in MMK.
 *
 * The upstream order/payment snapshot may carry any source currency (for
 * example USD). The invoice currency is relabeled to MMK while the monetary
 * amounts are kept exactly as received — no conversion or exchange-rate math.
 */
export const requireMmkInvoiceCurrency = (_value?: string | null): string => 'MMK';

const REACT_PRINT_PDF_MARKER = '/react-print-v15/';

export const hasCurrentInvoicePdf = (pdfUrl?: string | null): boolean =>
  Boolean(pdfUrl?.includes(REACT_PRINT_PDF_MARKER));

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
    if (snapshot.customerId !== customerId) {
      throw new ForbiddenError('Invoice order does not belong to this customer');
    }

    const currency = requireMmkInvoiceCurrency(snapshot.currency);

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
    const shopSnapshot = await shopLookupService.getShopInvoiceSnapshot(shopId);
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
      orderId: normalizedRequest.orderId,
      shopId,
      shopName: shopSnapshot?.name ?? null,
      customerId,
      customerName: normalizedRequest.customerName || null,
      customerEmail: normalizedRequest.customerEmail || null,
      customerPhone: getSnapshotCustomerPhone(snapshot),
      billingAddress: toPrismaJsonAddress(snapshot.billingAddress),
      shippingAddress: toPrismaJsonAddress(snapshot.shippingAddress),
      shopContactName: shopSnapshot?.contactName ?? null,
      shopContactEmail: shopSnapshot?.contactEmail ?? null,
      shopContactPhone: shopSnapshot?.contactPhone ?? null,
      shopAddress: shopSnapshot?.address ?? null,
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
    paymentStatus: 'PAID' | 'UNPAID' | 'COLLECTED';
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

    const snapshotCurrency = requireMmkInvoiceCurrency(snapshot.currency);
    const paymentCurrency = requireMmkInvoiceCurrency(payload.currency);
    if (snapshotCurrency !== paymentCurrency) {
      throw new ValidationError(`Payment currency does not match order currency for ${payload.orderId}`);
    }

    const paymentMethod = normalizeString(payload.paymentMethod ?? snapshot.paymentMethod).toUpperCase()
      || ((payload.paymentStatus === 'UNPAID' || payload.paymentStatus === 'COLLECTED') ? 'COD' : '');
    this.validateSnapshotPayment(snapshot, payload.paymentStatus, paymentMethod);

    if (payload.paymentStatus === 'COLLECTED') {
      const existingInvoices = await invoiceRepository.findAllByOrderId(payload.orderId);
      const matchingCodInvoices = existingInvoices.filter((invoice) => (
        normalizeString(invoice.paymentMethod).toUpperCase() === 'COD'
        && (
          normalizeString(invoice.paymentGatewayRef) === normalizeString(payload.transactionId)
          || (
            !invoice.paymentGatewayRef
            && ['UNPAID', 'PENDING_VERIFICATION'].includes(invoice.status)
          )
        )
      ));
      if (matchingCodInvoices.length === 0) {
        throw new ValidationError('Collected payment does not match an existing COD invoice');
      }

      const collectable = matchingCodInvoices.filter((invoice) => (
        ['UNPAID', 'PENDING_VERIFICATION'].includes(invoice.status)
      ));
      for (const invoice of collectable) {
        const marked = await invoiceRepository.markCollected(invoice.id, payload.transactionId);
        if (marked) {
          void this.generatePdfAndPublishNotification(marked.id, marked, 'invoice.paid', { force: true });
        }
      }

      const currentInvoices = await invoiceRepository.findAllByOrderId(payload.orderId);
      const alreadyPaid = currentInvoices.filter((invoice) => (
        normalizeString(invoice.paymentMethod).toUpperCase() === 'COD'
        && normalizeString(invoice.paymentGatewayRef) === normalizeString(payload.transactionId)
        && invoice.status === 'PAID'
      ));
      if (alreadyPaid.length === 1) {
        return alreadyPaid[0];
      }
      if (alreadyPaid.length > 1) {
        return alreadyPaid;
      }

      throw new ValidationError('No unpaid or paid invoice matches the collected COD payment');
    }

    if (!snapshot.customerId.trim() || !payload.paymentId.trim() || !payload.transactionId.trim()) {
      throw new ValidationError('Payment identity and snapshot customer ID are required');
    }

    return this.createInvoicesFromSnapshot(snapshot, {
      paymentStatus: payload.paymentStatus,
      paymentMethod,
      currency: snapshotCurrency,
      customerName: payload.customerName,
      customerEmail: payload.customerEmail,
      shopName: payload.shopName,
      idempotencyKeyBase: `payment:${payload.paymentId}`,
      paymentId: payload.paymentId,
      transactionId: payload.transactionId,
    });
  }

  async replayInvoices(orderIds: string[]): Promise<InvoiceReplaySummary> {
    const uniqueOrderIds = [...new Set(orderIds.map((orderId) => orderId.trim()))];
    if (uniqueOrderIds.length === 0 || uniqueOrderIds.length > MAX_INVOICE_REPLAY_ORDER_IDS) {
      throw new ValidationError(`Provide between 1 and ${MAX_INVOICE_REPLAY_ORDER_IDS} order IDs`);
    }

    const summary: InvoiceReplaySummary = {
      total: uniqueOrderIds.length,
      created: 0,
      skipped_existing: 0,
      skipped_ineligible: 0,
      failed: 0,
      results: [],
    };

    for (const orderId of uniqueOrderIds) {
      try {
        if (await invoiceRepository.findByOrderId(orderId)) {
          summary.skipped_existing += 1;
          summary.results.push({ orderId, status: 'ALREADY_EXISTS' });
          continue;
        }

        const snapshot = await orderSnapshotService.getInvoiceSnapshot(orderId);
        if (snapshot.orderId !== orderId) {
          throw new ValidationError('Order snapshot does not match the requested order');
        }

        const paymentStatus = getFinalInvoicePaymentStatus('order.paid', {
          payment_status: normalizeString(snapshot.paymentStatus).toUpperCase(),
        });
        if (paymentStatus !== 'PAID' && paymentStatus !== 'UNPAID') {
          summary.skipped_ineligible += 1;
          summary.results.push({
            orderId,
            status: 'INELIGIBLE',
            reason: 'Order snapshot is not eligible under the order.paid invoice policy',
          });
          continue;
        }

        const paymentMethod = normalizeString(snapshot.paymentMethod).toUpperCase()
          || (paymentStatus === 'UNPAID' ? 'COD' : '');
        this.validateSnapshotPayment(snapshot, paymentStatus, paymentMethod);

        await this.createInvoicesFromSnapshot(snapshot, {
          paymentStatus,
          paymentMethod,
          currency: requireMmkInvoiceCurrency(snapshot.currency),
          idempotencyKeyBase: `replay:${snapshot.orderId}`,
        });
        summary.created += 1;
        summary.results.push({ orderId, status: 'CREATED' });
      } catch (error) {
        let invoiceExists = false;
        try {
          invoiceExists = Boolean(await invoiceRepository.findByOrderId(orderId));
        } catch (lookupError) {
          logger.error(`Failed to check invoice replay state for order ${orderId}`, lookupError as Error);
        }

        if (invoiceExists) {
          summary.skipped_existing += 1;
          summary.results.push({ orderId, status: 'ALREADY_EXISTS' });
          continue;
        }

        logger.error(`Failed to replay invoice for order ${orderId}`, error as Error);
        summary.failed += 1;
        summary.results.push({
          orderId,
          status: 'FAILED',
          reason: this.getReplayFailureReason(error),
        });
      }
    }

    return summary;
  }

  async getMissingInvoices(limit = 25, cursor?: string | null): Promise<MissingInvoicePage> {
    const pageSize = Math.min(Math.max(Math.trunc(limit) || 25, 1), 100);
    const data: MissingInvoiceOrder[] = [];
    let nextCursor = cursor ?? null;
    let scanned = 0;
    const shopNamesById = new Map<string, string | null>();

    while (data.length < pageSize && scanned < MAX_CANDIDATES_PER_REPLAY_REQUEST) {
      const candidates = await orderSnapshotService.getInvoiceCandidates(MISSING_INVOICE_PAGE_SIZE, nextCursor);
      if (candidates.orders.length === 0) {
        nextCursor = candidates.nextCursor;
        break;
      }
      scanned += candidates.orders.length;

      const invoicePairs = await invoiceRepository.findInvoiceShopPairsByOrderIds(
        candidates.orders.map((candidate) => candidate.snapshot.orderId),
      );
      const existingByOrder = new Map<string, Set<string>>();
      for (const pair of invoicePairs) {
        const shops = existingByOrder.get(pair.orderId) ?? new Set<string>();
        shops.add(pair.shopId);
        existingByOrder.set(pair.orderId, shops);
      }

      for (let index = 0; index < candidates.orders.length; index += 1) {
        const candidate = candidates.orders[index];
        nextCursor = candidate.cursorAfter;
        const snapshot = candidate.snapshot;
        const paymentStatus = this.getEligiblePaymentStatus(snapshot);
        if (!paymentStatus) continue;

        const missingShops = this.getMissingShopInvoices(
          snapshot,
          paymentStatus,
          existingByOrder.get(snapshot.orderId) ?? new Set<string>(),
        );
        if (missingShops.length > 0) {
          await Promise.all(missingShops.map(async (shop) => {
            if (shop.shopName?.trim() || shopNamesById.has(shop.shopId)) return;
            const name = await shopLookupService.getShopName(shop.shopId);
            shopNamesById.set(shop.shopId, name);
          }));
          data.push({
            orderId: snapshot.orderId,
            customerId: snapshot.customerId,
            customerName: snapshot.customerName ?? null,
            paymentStatus: normalizeString(snapshot.paymentStatus).toUpperCase(),
            paymentMethod: snapshot.paymentMethod ?? null,
            currency: snapshot.currency,
            createdAt: candidate.createdAt,
            missingShops: missingShops.map((shop) => ({
              ...shop,
              shopName: shop.shopName?.trim() || shopNamesById.get(shop.shopId) || null,
            })),
          });
        }

        if (data.length >= pageSize) {
          if (index === candidates.orders.length - 1) {
            nextCursor = candidates.nextCursor;
          }
          break;
        }
      }

      if (data.length >= pageSize) break;
      if (!candidates.nextCursor) {
        nextCursor = null;
        break;
      }
      if (nextCursor === candidates.nextCursor) break;
      nextCursor = candidates.nextCursor;
    }

    return { data, nextCursor, hasMore: nextCursor !== null };
  }

  async replayMissingInvoice(
    orderId: string,
    shopId: string,
  ): Promise<MissingInvoiceReplayResult> {
    try {
      const existing = await invoiceRepository.findByOrderIdAndShopId(orderId, shopId);
      if (existing) return { orderId, shopId, status: 'ALREADY_EXISTS' };

      const snapshot = await orderSnapshotService.getInvoiceSnapshot(orderId);
      if (snapshot.orderId !== orderId) {
        throw new ValidationError('Order snapshot does not match the requested order');
      }

      return this.replayMissingInvoiceFromSnapshot(orderId, shopId, snapshot);
    } catch (error) {
      const existing = await invoiceRepository.findByOrderIdAndShopId(orderId, shopId).catch(() => null);
      if (existing) return { orderId, shopId, status: 'ALREADY_EXISTS' };
      logger.error(`Failed to replay missing invoice for order ${orderId}, shop ${shopId}`, error as Error);
      return {
        orderId,
        shopId,
        status: 'FAILED',
        reason: this.getReplayFailureReason(error),
      };
    }
  }

  async replayAllMissingInvoices(cursor?: string | null): Promise<MissingInvoiceReplaySummary> {
    const summary: MissingInvoiceReplaySummary = {
      total: 0,
      created: 0,
      skipped_existing: 0,
      skipped_ineligible: 0,
      failed: 0,
      hasMore: false,
      nextCursor: cursor ?? null,
      results: [],
    };
    let scanCursor = cursor ?? null;
    let scanned = 0;

    while (
      summary.total < MAX_MISSING_INVOICE_REPLAYS_PER_REQUEST
      && scanned < MAX_CANDIDATES_PER_REPLAY_REQUEST
    ) {
      const candidates = await orderSnapshotService.getInvoiceCandidates(MISSING_INVOICE_PAGE_SIZE, scanCursor);
      if (candidates.orders.length === 0) {
        scanCursor = candidates.nextCursor;
        break;
      }
      scanned += candidates.orders.length;

      const invoicePairs = await invoiceRepository.findInvoiceShopPairsByOrderIds(
        candidates.orders.map((candidate) => candidate.snapshot.orderId),
      );
      const existingByOrder = new Map<string, Set<string>>();
      for (const pair of invoicePairs) {
        const shops = existingByOrder.get(pair.orderId) ?? new Set<string>();
        shops.add(pair.shopId);
        existingByOrder.set(pair.orderId, shops);
      }

      for (const candidate of candidates.orders) {
        if (summary.total >= MAX_MISSING_INVOICE_REPLAYS_PER_REQUEST) {
          return {
            ...summary,
            hasMore: true,
            nextCursor: scanCursor,
          };
        }
        const snapshot = candidate.snapshot;
        let missingShops: MissingInvoiceShop[];
        try {
          const paymentStatus = this.getEligiblePaymentStatus(snapshot);
          if (!paymentStatus) {
            scanCursor = candidate.cursorAfter;
            continue;
          }
          this.validateSnapshotPayment(
            snapshot,
            paymentStatus,
            normalizeString(snapshot.paymentMethod).toUpperCase()
              || (paymentStatus === 'UNPAID' ? 'COD' : ''),
          );
          missingShops = this.getMissingShopInvoices(
            snapshot,
            paymentStatus,
            existingByOrder.get(snapshot.orderId) ?? new Set<string>(),
          );
        } catch (error) {
          summary.total += 1;
          summary.failed += 1;
          summary.results.push({
            orderId: snapshot.orderId,
            shopId: '',
            status: 'FAILED',
            reason: this.getReplayFailureReason(error),
          });
          scanCursor = candidate.cursorAfter;
          continue;
        }

        for (const missingShop of missingShops) {
          if (summary.total >= MAX_MISSING_INVOICE_REPLAYS_PER_REQUEST) {
            return {
              ...summary,
              hasMore: true,
              nextCursor: scanCursor,
            };
          }
          const result = await this.replayMissingInvoiceFromSnapshot(
            snapshot.orderId,
            missingShop.shopId,
            snapshot,
          );
          summary.total += 1;
          summary.results.push(result);
          if (result.status === 'CREATED') summary.created += 1;
          else if (result.status === 'ALREADY_EXISTS') summary.skipped_existing += 1;
          else if (result.status === 'INELIGIBLE') summary.skipped_ineligible += 1;
          else summary.failed += 1;
        }
        scanCursor = candidate.cursorAfter;
      }

      if (!candidates.nextCursor) {
        scanCursor = null;
        break;
      }
      scanCursor = candidates.nextCursor;
    }

    summary.nextCursor = scanCursor;
    summary.hasMore = scanCursor !== null;
    return summary;
  }

  private getEligiblePaymentStatus(snapshot: OrderInvoiceSnapshot): 'PAID' | 'UNPAID' | null {
    const status = getFinalInvoicePaymentStatus('order.paid', {
      payment_status: normalizeString(snapshot.paymentStatus).toUpperCase(),
    });
    return status === 'PAID' || status === 'UNPAID' ? status : null;
  }

  private async replayMissingInvoiceFromSnapshot(
    orderId: string,
    shopId: string,
    snapshot: OrderInvoiceSnapshot,
  ): Promise<MissingInvoiceReplayResult> {
    try {
      if (snapshot.orderId !== orderId) {
        throw new ValidationError('Order snapshot does not match the requested order');
      }
      if (await invoiceRepository.findByOrderIdAndShopId(orderId, shopId)) {
        return { orderId, shopId, status: 'ALREADY_EXISTS' };
      }

      const paymentStatus = this.getEligiblePaymentStatus(snapshot);
      if (!paymentStatus) {
        return {
          orderId,
          shopId,
          status: 'INELIGIBLE',
          reason: 'Order snapshot is not eligible under the order.paid invoice policy',
        };
      }

      const paymentMethod = normalizeString(snapshot.paymentMethod).toUpperCase()
        || (paymentStatus === 'UNPAID' ? 'COD' : '');
      this.validateSnapshotPayment(snapshot, paymentStatus, paymentMethod);
      if (!this.getMissingShopInvoices(snapshot, paymentStatus, new Set()).some((shop) => shop.shopId === shopId)) {
        return {
          orderId,
          shopId,
          status: 'INELIGIBLE',
          reason: 'Requested shop is not present in the order snapshot',
        };
      }

      await this.createInvoicesFromSnapshot(snapshot, {
        paymentStatus,
        paymentMethod,
        currency: requireMmkInvoiceCurrency(snapshot.currency),
        idempotencyKeyBase: `replay:${snapshot.orderId}`,
        onlyShopId: shopId,
      });
      const created = await invoiceRepository.findByOrderIdAndShopId(orderId, shopId);
      return created
        ? { orderId, shopId, status: 'CREATED' }
        : {
          orderId,
          shopId,
          status: 'FAILED',
          reason: 'Invoice creation did not produce an invoice for the requested shop',
        };
    } catch (error) {
      const existing = await invoiceRepository.findByOrderIdAndShopId(orderId, shopId).catch(() => null);
      if (existing) return { orderId, shopId, status: 'ALREADY_EXISTS' };
      logger.error(`Failed to replay missing invoice for order ${orderId}, shop ${shopId}`, error as Error);
      return {
        orderId,
        shopId,
        status: 'FAILED',
        reason: this.getReplayFailureReason(error),
      };
    }
  }

  private getMissingShopInvoices(
    snapshot: OrderInvoiceSnapshot,
    paymentStatus: 'PAID' | 'UNPAID',
    existingShopIds: Set<string>,
  ): MissingInvoiceShop[] {
    const itemsByShop = new Map<string, OrderInvoiceSnapshotItem[]>();
    for (const item of snapshot.items) {
      const shopId = item.shopId?.trim();
      if (!shopId) throw new ValidationError('Order snapshot does not contain a shop ID');
      const items = itemsByShop.get(shopId) ?? [];
      items.push(item);
      itemsByShop.set(shopId, items);
    }
    const shopTotals = allocateShopTotals(
      snapshot.subtotal,
      snapshot.deliveryFee,
      snapshot.promotionDiscountTotal,
      [...itemsByShop.entries()].map(([shopId, items]) => ({
        shopId,
        subtotal: calculateShopSubtotal(items),
      })),
    );
    return shopTotals
      .filter((shop) => !existingShopIds.has(shop.shopId))
      .map((shop) => ({
        ...shop,
        shopName: itemsByShop.get(shop.shopId)?.find((item) => item.shopName?.trim())?.shopName ?? null,
        expectedInvoiceStatus: paymentStatus,
        reason: 'NO_INVOICE_FOR_SHOP',
      }));
  }

  private getReplayFailureReason(error: unknown): string {
    if (error instanceof OrderSnapshotError || error instanceof ValidationError) {
      return error.message;
    }
    if (error instanceof AppError) {
      return error.message;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return `Invoice database operation failed (${error.code})`;
    }
    return 'Invoice replay failed due to an unexpected service error';
  }

  private validateSnapshotPayment(
    snapshot: OrderInvoiceSnapshot,
    paymentStatus: 'PAID' | 'UNPAID' | 'COLLECTED',
    paymentMethod: string,
  ): void {
    const snapshotPaymentMethod = normalizeString(snapshot.paymentMethod).toUpperCase();
    const snapshotPaymentStatus = normalizeString(snapshot.paymentStatus).toUpperCase();

    if (paymentStatus === 'COLLECTED' && paymentMethod !== 'COD') {
      throw new ValidationError('Collected payment invoices require COD payment method');
    }
    if (paymentStatus === 'UNPAID' && paymentMethod !== 'COD') {
      throw new ValidationError('Unpaid event invoices are only issued for COD');
    }
    if (paymentStatus === 'PAID' && paymentMethod === 'COD') {
      throw new ValidationError('COD invoices are issued unpaid until collection');
    }
    if (paymentStatus === 'PAID' && snapshotPaymentStatus !== 'PAID') {
      throw new ValidationError('Order snapshot is not in a paid state');
    }
    if (
      paymentStatus === 'UNPAID'
      && snapshotPaymentMethod !== 'COD'
      && snapshotPaymentStatus !== 'COD'
    ) {
      throw new ValidationError('Order snapshot is not a COD order');
    }
    if (paymentStatus === 'COLLECTED' && snapshotPaymentMethod !== 'COD') {
      throw new ValidationError('Collected payment does not match COD order snapshot');
    }
  }

  private async createInvoicesFromSnapshot(
    snapshot: OrderInvoiceSnapshot,
    payload: SnapshotInvoiceCreation,
  ) {
    if (!snapshot.customerId.trim()) {
      throw new ValidationError('Snapshot customer ID is required');
    }
    if (snapshot.items.length === 0) {
      throw new ValidationError('Order snapshot does not contain invoice items');
    }

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
    const shopDetails = await Promise.all(shops
      .filter(([shopId]) => !payload.onlyShopId || payload.onlyShopId === shopId)
      .map(async ([shopId]) => [
      shopId,
      await shopLookupService.getShopInvoiceSnapshot(shopId),
      ] as const));
    const shopSnapshots = new Map(shopDetails);
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
      if (payload.onlyShopId && payload.onlyShopId !== shopId) continue;
      const shopTotal = shopTotals[index];
      const snapshotShopName = items.find((item) => item.shopName?.trim())?.shopName;
      const shopSnapshot = shopSnapshots.get(shopId);
      const resolvedShopName = shopSnapshot?.name ?? null;
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
        orderItemId: item.orderItemId,
        name: item.productName?.trim() || item.productSku || item.productId,
        sku: item.productSku,
        imageUrl: item.imageUrl ?? null,
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
        currency: payload.currency,
        items: invoiceItems.map((item) => [item.orderItemId, item.requestedQuantity]),
      })).digest('hex');
      const idempotencyKey = shops.length === 1
        ? payload.idempotencyKeyBase
        : `${payload.idempotencyKeyBase}:shop:${shopId}`;

      const invoice = await invoiceRepository.createPaidInvoiceFromPayment({
        orderId: snapshot.orderId,
        shopId,
        shopName: normalizeString(shopName) || null,
        customerId: snapshot.customerId,
        customerName: displayData.customerName,
        customerEmail: displayData.customerEmail,
        customerPhone: getSnapshotCustomerPhone(snapshot),
        billingAddress: toPrismaJsonAddress(snapshot.billingAddress),
        shippingAddress: toPrismaJsonAddress(snapshot.shippingAddress),
        shopContactName: shopSnapshot?.contactName ?? null,
        shopContactEmail: shopSnapshot?.contactEmail ?? null,
        shopContactPhone: shopSnapshot?.contactPhone ?? null,
        shopAddress: shopSnapshot?.address ?? null,
        currency: payload.currency,
        subtotal: shopTotal.subtotal,
        deliveryFee: shopTotal.deliveryFee,
        taxAmount: '0.00',
        discountAmount: shopTotal.discountAmount,
        grandTotal: shopTotal.grandTotal,
        paymentMethod: payload.paymentMethod || null,
        paymentGatewayRef: payload.transactionId ?? null,
        lineItems,
        items: invoiceItems,
        idempotencyKey,
        requestHash,
        status: payload.paymentStatus === 'UNPAID' ? 'UNPAID' : 'PAID',
      });

      invoices.push(invoice);
      void this.generatePdfAndPublishNotification(invoice.id, invoice, 'invoice.generated');
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

      void this.generatePdfAsync(updatedInvoice.id, updatedInvoice, { force: true });
      return updatedInvoice;
    }

    const updatedInvoice = await invoiceRepository.transitionVerification(id, false, verifiedBy, rejectionReason);
    if (!updatedInvoice) {
      throw new ConflictError('Invoice has already been verified');
    }
    void this.generatePdfAsync(updatedInvoice.id, updatedInvoice, { force: true });
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

    const updatedInvoice = await invoiceRepository.updateStatus(id, {
      status: 'VOID',
      verifiedBy: voidedBy,
      verifiedAt: new Date(),
      rejectionReason: reason,
    });
    void this.generatePdfAsync(updatedInvoice.id, updatedInvoice, { force: true });
    return updatedInvoice;
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

    const updatedInvoice = await invoiceRepository.updateStatus(id, {
      status: 'REFUNDED',
      verifiedBy: refundedBy,
      verifiedAt: new Date(),
      refundAmount: amount,
      refundMethod: method,
      refundReason: reason,
    });
    void this.generatePdfAsync(updatedInvoice.id, updatedInvoice, { force: true });
    return updatedInvoice;
  }

  async getInvoicesByCustomer(customerId: string) {
    return invoiceRepository.listInvoices({ customerId });
  }

  async getGuestInvoicesByOrder(orderId: string, phone: string) {
    const normalizedOrderId = normalizeString(orderId);
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedOrderId || normalizedPhone.length < 8) {
      throw new ValidationError('Order ID and phone number are required');
    }

    return this.getGuestInvoicesForOrder(normalizedOrderId, normalizedPhone);
  }

  async getGuestInvoicesByCheckout(checkoutId: string, phone: string) {
    const normalizedCheckoutId = normalizeString(checkoutId);
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedCheckoutId || normalizedPhone.length < 8) {
      throw new ValidationError('Checkout ID and phone number are required');
    }

    const snapshot = await orderSnapshotService.getInvoiceSnapshotByCheckoutId(normalizedCheckoutId);
    return this.getGuestInvoicesForOrder(snapshot.orderId, normalizedPhone);
  }

  private async getGuestInvoicesForOrder(orderId: string, normalizedPhone: string) {
    const invoices = await invoiceRepository.findAllByOrderId(orderId);
    const matchingInvoices = invoices.filter((invoice) =>
      normalizePhoneNumber(invoice.customerPhone) === normalizedPhone,
    );

    return Promise.all(matchingInvoices.map((invoice) => this.getInvoiceById(invoice.id)))
      .then((documents) => documents.filter((invoice) => invoice !== null));
  }

  async getInvoicesByShop(shopId: string, status?: InvoiceStatus) {
    return invoiceRepository.listInvoices({ shopId, status });
  }

  async getInvoicesByShops(shopIds: string[]) {
    return invoiceRepository.listInvoices({ shopIds });
  }

  async getAllInvoices(status?: InvoiceStatus) {
    const invoices = await invoiceRepository.listInvoices({ status });
    return populateMissingInvoiceShopNames(invoices);
  }

  async getInvoiceById(id: string) {
    const invoice = await invoiceRepository.findDocumentById(id);
    return invoice ? this.populateMissingLineItemImages(invoice) : null;
  }

  async getCustomerInvoiceByNumber(invoiceNumber: string, customerId: string) {
    const invoice = await invoiceRepository.findDocumentByInvoiceNumber(invoiceNumber);
    if (!invoice || invoice.customerId !== customerId) {
      return null;
    }

    return this.populateMissingLineItemImages(invoice);
  }

  async getInvoiceByNumber(invoiceNumber: string) {
    const invoice = await invoiceRepository.findDocumentByInvoiceNumber(invoiceNumber);
    return invoice ? this.populateMissingLineItemImages(invoice) : null;
  }

  private async populateMissingLineItemImages<T extends {
    orderId: string;
    lineItems: InvoiceLineItem[] | null;
  }>(invoice: T): Promise<T> {
    const lineItems = invoice.lineItems ?? [];
    if (lineItems.length === 0 || lineItems.every((item) => item.imageUrl?.trim())) {
      return invoice;
    }

    let snapshot: Awaited<ReturnType<typeof orderSnapshotService.getInvoiceSnapshot>>;
    try {
      snapshot = await orderSnapshotService.getInvoiceSnapshot(invoice.orderId);
    } catch (error) {
      logger.warn('Unable to hydrate historical invoice images; returning persisted invoice data', {
        orderId: invoice.orderId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ...invoice,
        lineItems: lineItems.map((item) => ({
          ...item,
          imageUrl: item.imageUrl?.trim() || null,
        })),
      };
    }

    const imageUrlsByOrderItemId = new Map(
      snapshot.items.flatMap((item) => {
        const imageUrl = item.imageUrl?.trim();
        return imageUrl ? [[item.orderItemId, imageUrl] as const] : [];
      }),
    );

    return {
      ...invoice,
      lineItems: lineItems.map((item) => ({
        ...item,
        imageUrl: item.imageUrl?.trim()
          || (item.orderItemId ? imageUrlsByOrderItemId.get(item.orderItemId) : undefined)
          || null,
      })),
    };
  }

  async downloadInvoicePdf(id: string, actor: InvoiceAccessActor) {
    const invoice = await invoiceRepository.findById(id);
    if (!invoice || !canAccessInvoice(invoice, actor)) {
      return null;
    }

    let pdfUrl = invoice.pdfUrl;
    if (pdfUrl && hasCurrentInvoicePdf(pdfUrl)) {
      try {
        return {
          invoice,
          buffer: await storageService.downloadPdf(pdfUrl),
        };
      } catch (error) {
        logger.warn('Stored invoice PDF could not be downloaded; regenerating it', {
          invoiceId: invoice.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.generatePdfAsync(invoice.id, invoice, { force: Boolean(pdfUrl), throwOnFailure: true });
    pdfUrl = (await invoiceRepository.findById(id))?.pdfUrl ?? null;
    if (!pdfUrl) {
      throw new Error('Invoice PDF generation completed without a downloadable PDF');
    }

    return {
      invoice,
      buffer: await storageService.downloadPdf(pdfUrl),
    };
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
      if (!hasCurrentInvoicePdf(pdfUrl)) {
        await this.generatePdfAsync(invoice.id, invoice, { force: true });
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
      orderReference?: string | null;
      shopId: string;
      shopName?: string | null;
      shopContactName?: string | null;
      shopContactEmail?: string | null;
      shopContactPhone?: string | null;
      shopAddress?: string | null;
      customerId: string;
      customerName?: string | null;
      customerEmail?: string | null;
      customerPhone?: string | null;
      billingAddress?: Prisma.JsonValue;
      shippingAddress?: Prisma.JsonValue;
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
      pdfUpdatedAt?: Date | null;
      updatedAt?: Date;
    },
    options: { force?: boolean; throwOnFailure?: boolean } = {},
  ): Promise<boolean> {
    if (!options.force && hasCurrentInvoicePdf(invoice.pdfUrl)) {
      return true;
    }

    const force = options.force ?? Boolean(invoice.pdfUrl);
    if (!(await invoiceRepository.claimPdfGeneration(invoiceId, { force }))) {
      if (options.throwOnFailure) {
        throw new Error('Invoice PDF generation is already in progress; please retry the download.');
      }
      return false;
    }

    try {
      const pdfUrl = await pdfGeneratorService.buildAndUploadInvoicePdf({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        orderReference: invoice.orderReference ?? null,
        orderId: invoice.orderId,
        shopId: invoice.shopId,
        customerId: invoice.customerId,
        shopName: invoice.shopName,
        shopContactName: invoice.shopContactName,
        shopContactEmail: invoice.shopContactEmail,
        shopContactPhone: invoice.shopContactPhone,
        shopAddress: invoice.shopAddress,
        customerName: invoice.customerName,
        customerEmail: invoice.customerEmail,
        customerPhone: invoice.customerPhone,
        billingAddress: normalizePdfAddress(invoice.billingAddress),
        shippingAddress: normalizePdfAddress(invoice.shippingAddress),
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
      return true;
    } catch (error) {
      await invoiceRepository.markPdfFailed(invoiceId, error instanceof Error ? error.message : 'PDF generation failed');
      logger.error(`Failed to generate invoice PDF for ${invoiceId}`, error as Error);
      if (options.throwOnFailure) {
        throw error instanceof Error ? error : new Error('Invoice PDF generation failed');
      }
      return false;
    }
  }

  private async generatePdfAndPublishNotification(
    invoiceId: string,
    invoice: Parameters<InvoiceService['generatePdfAsync']>[1],
    eventType: InvoiceNotificationType,
    options: { force?: boolean } = {},
  ): Promise<void> {
    try {
      if (!(await this.generatePdfAsync(invoiceId, invoice, options))) return;
      const persistedInvoice = await invoiceRepository.findById(invoiceId);
      if (!persistedInvoice?.pdfUrl || persistedInvoice.pdfStatus !== 'READY') return;
      await invoiceNotificationPublisher.publish(eventType, persistedInvoice);
    } catch (error) {
      logger.error(`Failed to publish ${eventType} notification for invoice ${invoiceId}`, error as Error);
    }
  }

  async downloadInvoicePdfForNotification(invoiceId: string, pdfUrl: string) {
    const invoice = await invoiceRepository.findById(invoiceId);
    if (!invoice || !invoice.pdfUrl || invoice.pdfStatus !== 'READY') return null;

    const prefix = `invoice-pdfs/${invoice.shopId}/react-print-v15/${invoice.invoiceNumber}-`;
    if (
      !pdfUrl.startsWith(prefix)
      || !/^\d+-[a-z0-9]+\.pdf$/i.test(pdfUrl.slice(prefix.length))
      || pdfUrl.includes('..')
      || pdfUrl.includes('\\')
    ) {
      throw new ForbiddenError('Invoice PDF reference is invalid');
    }

    return {
      invoice,
      buffer: await storageService.downloadPdf(pdfUrl),
    };
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
    }).map((item) => ({
      ...item,
      orderItemId: typeof item.orderItemId === 'string' ? item.orderItemId : undefined,
      sku: typeof item.sku === 'string' ? item.sku : null,
    }));
  }
}

export default new InvoiceService();
