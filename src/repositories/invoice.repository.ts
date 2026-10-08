import prisma from '@/config/database';
import { Prisma } from '@prisma/client';
import { InvoiceFilters, InvoiceLineItem, InvoiceStatus } from '@/types/invoice';
import { OrderInvoiceSnapshotItem } from '@/services/order-snapshot.service';

export class InvoiceRepository {
  private normalizeLineItems(
    lineItems: unknown,
    items: Array<{
      orderItemId: string;
      productSku: string | null;
      productName: string;
      quantity: number;
      unitPrice: { toString(): string };
      totalPrice: { toString(): string };
    }>,
  ): InvoiceLineItem[] {
    const stored = Array.isArray(lineItems)
      ? lineItems.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : [];
    if (stored.length === 0) {
      return items.map((item) => ({
        orderItemId: item.orderItemId,
        name: item.productName,
        sku: item.productSku,
        quantity: item.quantity,
        unitPrice: item.unitPrice.toString(),
        total: item.totalPrice.toString(),
      }));
    }

    return stored.map((item, index) => {
      const matchingItem = typeof item.orderItemId === 'string'
        ? items.find((candidate) => candidate.orderItemId === item.orderItemId) ?? items[index]
        : items[index];
      return {
        orderItemId: typeof item.orderItemId === 'string' ? item.orderItemId : matchingItem?.orderItemId,
        name: typeof item.name === 'string' ? item.name : matchingItem?.productName ?? 'Product information unavailable',
        sku: typeof item.sku === 'string' ? item.sku : matchingItem?.productSku ?? null,
        imageUrl: typeof item.imageUrl === 'string' ? item.imageUrl : null,
        quantity: typeof item.quantity === 'number' ? item.quantity : matchingItem?.quantity ?? 0,
        unitPrice: typeof item.unitPrice === 'string' ? item.unitPrice : matchingItem?.unitPrice.toString() ?? '0.00',
        total: typeof item.total === 'string' ? item.total : matchingItem?.totalPrice.toString() ?? '0.00',
      };
    });
  }

  private dateStamp(date = new Date()): string {
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  private async nextSequenceNumber(tx: Prisma.TransactionClient, date: string): Promise<number> {
    const sequence = await tx.invoiceSequence.upsert({
      where: { date },
      update: { lastNumber: { increment: 1 } },
      create: { date, lastNumber: 1 },
    });
    return sequence.lastNumber;
  }

  private async createInvoiceNumber(tx: Prisma.TransactionClient): Promise<string> {
    const date = this.dateStamp();
    const sequence = await this.nextSequenceNumber(tx, date);
    return `INV-${date}-${String(sequence).padStart(6, '0')}`;
  }

  private async getOrCreateOrderReference(tx: Prisma.TransactionClient, orderId: string): Promise<string> {
    const existing = await tx.invoiceOrderReference.findUnique({ where: { orderId } });
    if (existing) return existing.orderReference;

    const placeholder = `PENDING-${orderId}`;
    let created: { id: number };
    try {
      created = await tx.invoiceOrderReference.create({
        data: { orderId, orderReference: placeholder },
        select: { id: true },
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
      const concurrent = await tx.invoiceOrderReference.findUnique({ where: { orderId } });
      if (concurrent) return concurrent.orderReference;
      throw error;
    }
    const date = this.dateStamp();
    const sequence = await this.nextSequenceNumber(tx, date);
    const orderReference = `ORD-${date}-${String(sequence).padStart(6, '0')}`;
    const updated = await tx.invoiceOrderReference.update({
      where: { id: created.id },
      data: { orderReference },
    });
    return updated.orderReference;
  }

  /**
   * Legacy compatibility helper.
   *
   * One order can now have multiple invoices, so orderId is no longer unique.
   * This method returns the most recently created invoice for the order.
   *
   * NOTE:
   * New partial-invoice logic should use findById() or another
   * invoice-specific lookup instead of relying on this method.
   */
  async findByOrderId(orderId: string) {
    return prisma.invoice.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAllByOrderId(orderId: string) {
    return prisma.invoice.findMany({
      where: { orderId },
      include: { items: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findByOrderIdAndShopId(orderId: string, shopId: string) {
    return prisma.invoice.findFirst({
      where: { orderId, shopId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findInvoiceShopPairsByOrderIds(orderIds: string[]): Promise<Array<{ orderId: string; shopId: string }>> {
    if (orderIds.length === 0) return [];
    return prisma.invoice.findMany({
      where: { orderId: { in: orderIds } },
      select: { orderId: true, shopId: true },
      distinct: ['orderId', 'shopId'],
    });
  }

  async markCollected(id: string, paymentGatewayRef: string) {
    const result = await prisma.invoice.updateMany({
      where: {
        id,
        status: { in: ['UNPAID', 'PENDING_VERIFICATION'] },
      },
      data: {
        status: 'PAID',
        paymentGatewayRef,
      },
    });

    if (result.count !== 1) {
      return null;
    }

    return this.findById(id);
  }

  async findById(id: string) {
    return prisma.invoice.findUnique({
      where: { id },
    });
  }

  async findDocumentById(id: string) {
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!invoice) return null;

    const { items, lineItems, ...document } = invoice;
    return {
      ...document,
      pdfUrl: document.pdfUrl ? `/invoices/${document.id}/pdf` : null,
      lineItems: this.normalizeLineItems(lineItems, items),
    };
  }

  async findDocumentByInvoiceNumber(invoiceNumber: string) {
    const invoice = await prisma.invoice.findFirst({
      where: {
        OR: [{ invoiceNumber }, { id: invoiceNumber }],
      },
      include: { items: true },
    });
    if (!invoice) return null;

    const { items, lineItems, ...document } = invoice;
    return {
      ...document,
      pdfUrl: document.pdfUrl ? `/invoices/${document.id}/pdf` : null,
      lineItems: this.normalizeLineItems(lineItems, items),
    };
  }

  async findIdempotency(idempotencyKey: string) {
    return prisma.invoiceIdempotency.findUnique({
      where: { idempotencyKey },
      include: { invoice: { include: { items: true } } },
    });
  }

  async createPaidInvoiceFromPayment(data: {
    orderId: string;
    orderReference?: string;
    shopId: string;
    shopName: string | null;
    customerId: string;
    customerName: string | null;
    customerEmail: string | null;
    customerPhone: string | null;
    billingAddress: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
    shippingAddress: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
    shopContactName: string | null;
    shopContactEmail: string | null;
    shopContactPhone: string | null;
    shopAddress: string | null;
    currency: string;
    subtotal: string;
    deliveryFee: string;
    taxAmount: string;
    discountAmount: string;
    grandTotal: string;
    paymentMethod: string | null;
    paymentGatewayRef: string | null;
    lineItems: InvoiceLineItem[];
    items: Array<OrderInvoiceSnapshotItem & { requestedQuantity: number }>;
    idempotencyKey: string;
    requestHash: string;
    status?: InvoiceStatus;
  }) {
    try {
      return await prisma.$transaction(async (tx) => {
      const existing = await tx.invoiceIdempotency.findUnique({
        where: { idempotencyKey: data.idempotencyKey },
        include: { invoice: { include: { items: true } } },
      });
      if (existing) {
        if (existing.requestHash !== data.requestHash) {
          throw new Error('Payment idempotency key was used with a different request');
        }
        return existing.invoice;
      }

      const orderReference = data.orderReference ?? await this.getOrCreateOrderReference(tx, data.orderId);
      const invoiceNumber = await this.createInvoiceNumber(tx);

      const allocations: Array<{ id: string; quantity: number }> = [];
      for (const item of data.items) {
        let allocation = await tx.invoiceOrderItemAllocation.findUnique({
          where: { orderItemId: item.orderItemId },
        });

        if (!allocation) {
          try {
            allocation = await tx.invoiceOrderItemAllocation.create({
              data: {
                orderItemId: item.orderItemId,
                orderId: data.orderId,
                shopId: data.shopId,
                orderedQuantity: item.quantity,
                allocatedQuantity: 0,
                productId: item.productId,
                productName: item.productName ?? '',
                productSku: item.productSku,
                unitPrice: item.unitPrice,
                currency: data.currency,
              },
            });
          } catch (error) {
            if (!this.isUniqueConstraintError(error)) throw error;
            allocation = await tx.invoiceOrderItemAllocation.findUnique({
              where: { orderItemId: item.orderItemId },
            });
          }
        }

        if (!allocation) throw new Error(`Allocation row could not be obtained for ${item.orderItemId}`);

        const lockedRows = await tx.$queryRaw<Array<{
          id: string;
          orderId: string;
          shopId: string;
          orderedQuantity: number;
          allocatedQuantity: number;
          productId: string;
          currency: string;
        }>>`
          SELECT id, orderId, shopId, orderedQuantity, allocatedQuantity, productId, currency
          FROM invoice_order_item_allocations
          WHERE orderItemId = ${item.orderItemId}
          FOR UPDATE
        `;
        const locked = lockedRows[0];
        if (!locked) throw new Error(`Allocation row could not be locked for ${item.orderItemId}`);
        if (
          locked.orderId !== data.orderId
          || locked.shopId !== data.shopId
          || locked.orderedQuantity !== item.quantity
          || locked.productId !== item.productId
          || locked.currency !== data.currency
        ) {
          throw new Error(`Order item ${item.orderItemId} no longer matches the order snapshot`);
        }

        const remaining = locked.orderedQuantity - locked.allocatedQuantity;
        if (item.requestedQuantity !== item.quantity || item.requestedQuantity > remaining) {
          throw new Error(`Order item ${item.orderItemId} is already allocated or no longer has its full quantity available`);
        }
        allocations.push({ id: locked.id, quantity: item.requestedQuantity });
      }

      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          orderId: data.orderId,
          orderReference,
          shopId: data.shopId,
          shopName: data.shopName,
          customerId: data.customerId,
          customerName: data.customerName,
          customerEmail: data.customerEmail,
          customerPhone: data.customerPhone,
          billingAddress: data.billingAddress,
          shippingAddress: data.shippingAddress,
          shopContactName: data.shopContactName,
          shopContactEmail: data.shopContactEmail,
          shopContactPhone: data.shopContactPhone,
          shopAddress: data.shopAddress,
          lineItems: data.lineItems as unknown as Prisma.InputJsonValue,
          subtotal: data.subtotal,
          deliveryFee: data.deliveryFee,
          taxAmount: data.taxAmount,
          discountAmount: data.discountAmount,
          grandTotal: data.grandTotal,
          currency: data.currency,
          paymentMethod: data.paymentMethod,
          paymentGatewayRef: data.paymentGatewayRef,
          status: data.status ?? 'PAID',
          items: {
            create: data.items.map((item) => ({
              orderItemId: item.orderItemId,
              productId: item.productId,
              productName: item.productName ?? '',
              productSku: item.productSku,
              quantity: item.requestedQuantity,
              unitPrice: item.unitPrice,
              taxAmount: '0',
              discountAmount: '0',
              totalPrice: item.lineTotal?.trim()
                ? item.lineTotal
                : this.multiplyMoney(item.unitPrice, item.requestedQuantity),
            })),
          },
        },
        include: { items: true },
      });

      for (const allocation of allocations) {
        await tx.invoiceOrderItemAllocation.update({
          where: { id: allocation.id },
          data: { allocatedQuantity: { increment: allocation.quantity } },
        });
      }

      await tx.invoiceIdempotency.create({
        data: {
          idempotencyKey: data.idempotencyKey,
          requestHash: data.requestHash,
          invoiceId: invoice.id,
        },
      });
      return invoice;
      }, { timeout: 15_000 });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const existing = await this.findIdempotency(data.idempotencyKey);
        if (existing?.requestHash === data.requestHash) return existing.invoice;
      }
      throw error;
    }
  }

  async createPartialInvoice(data: {
    orderId: string;
    shopId: string;
    shopName: string | null;
    customerId: string;
    customerName: string | null;
    customerEmail: string | null;
    customerPhone: string | null;
    billingAddress: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
    shippingAddress: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
    shopContactName: string | null;
    shopContactEmail: string | null;
    shopContactPhone: string | null;
    shopAddress: string | null;
    currency: string;
    paymentMethod: string | null;
    subtotal: string;
    taxAmount: string;
    discountAmount: string;
    grandTotal: string;
    items: Array<OrderInvoiceSnapshotItem & { requestedQuantity: number }>;
    idempotencyKey: string;
    requestHash: string;
  }) {
    try {
      return await prisma.$transaction(async (tx) => {
      const existingIdempotency = await tx.invoiceIdempotency.findUnique({
        where: { idempotencyKey: data.idempotencyKey },
        include: { invoice: { include: { items: true } } },
      });

      if (existingIdempotency) {
        if (existingIdempotency.requestHash !== data.requestHash) {
          throw new Error('Idempotency key was used with a different request');
        }
        return existingIdempotency.invoice;
      }

      const orderReference = await this.getOrCreateOrderReference(tx, data.orderId);
      const invoiceNumber = await this.createInvoiceNumber(tx);

      const allocations: Array<{ id: string; orderItemId: string; requestedQuantity: number }> = [];

      for (const item of data.items) {
        let allocation = await tx.invoiceOrderItemAllocation.findUnique({
          where: { orderItemId: item.orderItemId },
        });

        if (!allocation) {
          try {
            allocation = await tx.invoiceOrderItemAllocation.create({
              data: {
                orderItemId: item.orderItemId,
                orderId: data.orderId,
                shopId: data.shopId,
                orderedQuantity: item.quantity,
                allocatedQuantity: 0,
                productId: item.productId,
                productName: item.productName ?? '',
                productSku: item.productSku,
                unitPrice: item.unitPrice,
                currency: data.currency,
              },
            });
          } catch (error) {
            if (!this.isUniqueConstraintError(error)) {
              throw error;
            }
            allocation = await tx.invoiceOrderItemAllocation.findUnique({
              where: { orderItemId: item.orderItemId },
            });
          }
        }

        if (!allocation) {
          throw new Error(`Allocation row could not be obtained for ${item.orderItemId}`);
        }

        const lockedRows = await tx.$queryRaw<Array<{
          id: string;
          orderItemId: string;
          orderId: string;
          shopId: string;
          orderedQuantity: number;
          allocatedQuantity: number;
          productId: string;
          currency: string;
        }>>`
          SELECT id, orderItemId, orderId, shopId, orderedQuantity, allocatedQuantity, productId, currency
          FROM invoice_order_item_allocations
          WHERE orderItemId = ${item.orderItemId}
          FOR UPDATE
        `;

        if (lockedRows.length === 0) {
          throw new Error(`Allocation row could not be locked for ${item.orderItemId}`);
        }

        const lockedAllocation = lockedRows[0];
        if (
          lockedAllocation.orderId !== data.orderId
          || lockedAllocation.shopId !== data.shopId
          || lockedAllocation.orderedQuantity !== item.quantity
          || lockedAllocation.productId !== item.productId
          || lockedAllocation.currency !== data.currency
        ) {
          throw new Error(`Order item ${item.orderItemId} no longer matches the order snapshot`);
        }

        const remainingQuantity = lockedAllocation.orderedQuantity - lockedAllocation.allocatedQuantity;
        if (item.requestedQuantity <= 0 || item.requestedQuantity > remainingQuantity) {
          throw new Error(`Requested quantity for order item ${item.orderItemId} exceeds the remaining quantity`);
        }

        allocations.push({
          id: lockedAllocation.id,
          orderItemId: lockedAllocation.orderItemId,
          requestedQuantity: item.requestedQuantity,
        });
      }

      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          orderId: data.orderId,
          orderReference,
          shopId: data.shopId,
          shopName: data.shopName,
          customerId: data.customerId,
          customerName: data.customerName,
          customerEmail: data.customerEmail,
          customerPhone: data.customerPhone,
          billingAddress: data.billingAddress,
          shippingAddress: data.shippingAddress,
          shopContactName: data.shopContactName,
          shopContactEmail: data.shopContactEmail,
          shopContactPhone: data.shopContactPhone,
          shopAddress: data.shopAddress,
          lineItems: data.items.map((item) => ({
            orderItemId: item.orderItemId,
            name: item.productName ?? item.productSku ?? item.productId,
            sku: item.productSku,
            imageUrl: item.imageUrl ?? null,
            quantity: item.requestedQuantity,
            unitPrice: item.unitPrice,
            total: this.multiplyMoney(item.unitPrice, item.requestedQuantity),
          })) as unknown as Prisma.InputJsonValue,
          subtotal: data.subtotal,
          deliveryFee: '0.00',
          taxAmount: data.taxAmount,
          discountAmount: data.discountAmount,
          grandTotal: data.grandTotal,
          currency: data.currency,
          paymentMethod: data.paymentMethod as string,
          status: 'UNPAID',
          items: {
            create: data.items.map((item) => ({
              orderItemId: item.orderItemId,
              productId: item.productId,
              productName: item.productName ?? '',
              productSku: item.productSku,
              quantity: item.requestedQuantity,
              unitPrice: item.unitPrice,
              taxAmount: '0',
              discountAmount: '0',
              totalPrice: this.multiplyMoney(item.unitPrice, item.requestedQuantity),
            })),
          },
        },
        include: { items: true },
      });

      for (const allocation of allocations) {
        await tx.invoiceOrderItemAllocation.update({
          where: { id: allocation.id },
          data: {
            allocatedQuantity: {
              increment: allocation.requestedQuantity,
            },
          },
        });
      }

      await tx.invoiceIdempotency.create({
        data: {
          idempotencyKey: data.idempotencyKey,
          requestHash: data.requestHash,
          invoiceId: invoice.id,
        },
      });

      return invoice;
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const existing = await this.findIdempotency(data.idempotencyKey);
        if (existing?.requestHash === data.requestHash) return existing.invoice;
      }
      throw error;
    }
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
  }

  private multiplyMoney(unitPrice: string, quantity: number): string {
    const [whole, fraction = ''] = unitPrice.split('.');
    const cents = BigInt(`${whole}${fraction.padEnd(2, '0').slice(0, 2)}`) * BigInt(quantity);
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  }

  async updatePaymentSlip(id: string, paymentSlipUrl: string) {
    return prisma.invoice.update({
      where: { id },
      data: {
        paymentSlipUrl,
        status: 'PENDING_VERIFICATION',
        rejectionReason: null,
      },
    });
  }

  async updateStatus(
    id: string,
    data: {
      status?: InvoiceStatus;
      pdfUrl?: string | null;
      verifiedBy?: string | null;
      verifiedAt?: Date | null;
      rejectionReason?: string | null;
      verificationNote?: string | null;
      refundAmount?: string | null;
      refundMethod?: string | null;
      refundReason?: string | null;
    },
  ) {
    return prisma.invoice.update({
      where: { id },
      data,
    });
  }

  async transitionVerification(
    id: string,
    approved: boolean,
    verifiedBy: string,
    reason?: string,
  ) {
    const result = await prisma.invoice.updateMany({
      where: {
        id,
        status: 'PENDING_VERIFICATION',
      },
      data: approved
        ? {
          status: 'PAID',
          verifiedBy,
          verifiedAt: new Date(),
          rejectionReason: null,
          verificationNote: reason ?? null,
        }
        : {
          status: 'REJECTED',
          verifiedBy,
          verifiedAt: new Date(),
          rejectionReason: reason ?? 'Payment verification rejected',
        },
    });

    if (result.count !== 1) {
      return null;
    }

    return this.findById(id);
  }

  /**
   * Claims exclusive PDF generation for an invoice.
   *
   * By default a claim only succeeds while no PDF exists yet. `force` allows a
   * deliberate re-render of an invoice that already has a stored PDF (used when
   * the customer downloads it, so the file always matches the current design),
   * while still respecting the in-progress lock.
   */
  async claimPdfGeneration(id: string, options: { force?: boolean } = {}): Promise<boolean> {
    const result = await prisma.invoice.updateMany({
      where: {
        id,
        ...(options.force ? {} : { pdfUrl: null }),
        OR: [
          { pdfStatus: { not: 'GENERATING' } },
          {
            pdfStatus: 'GENERATING',
            pdfUpdatedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) },
          },
        ],
      },
      data: {
        pdfStatus: 'GENERATING',
        pdfError: null,
        pdfAttemptCount: { increment: 1 },
        pdfUpdatedAt: new Date(),
      },
    });

    return result.count === 1;
  }

  async markPdfReady(id: string, pdfUrl: string) {
    return prisma.invoice.update({
      where: { id },
      data: {
        pdfUrl,
        pdfStatus: 'READY',
        pdfError: null,
        pdfUpdatedAt: new Date(),
      },
    });
  }

  async markPdfFailed(id: string, error: string) {
    return prisma.invoice.update({
      where: { id },
      data: {
        pdfStatus: 'FAILED',
        pdfError: error.slice(0, 4000),
        pdfUpdatedAt: new Date(),
      },
    });
  }

  async listInvoices(
    filters: InvoiceFilters = {},
    skip = 0,
    take = 50,
  ) {
    const invoices = await prisma.invoice.findMany({
      where: {
        ...(filters.shopIds ? { shopId: { in: filters.shopIds } } : filters.shopId ? { shopId: filters.shopId } : {}),
        ...(filters.customerId ? { customerId: filters.customerId } : {}),
        ...(filters.orderId ? { orderId: filters.orderId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      select: {
        id: true,
        invoiceNumber: true,
        orderId: true,
        orderReference: true,
        shopId: true,
        shopName: true,
        customerId: true,
        customerName: true,
        customerEmail: true,
        customerPhone: true,
        billingAddress: true,
        shippingAddress: true,
        shopContactName: true,
        shopContactEmail: true,
        shopContactPhone: true,
        shopAddress: true,
        subtotal: true,
        taxAmount: true,
        discountAmount: true,
        deliveryFee: true,
        grandTotal: true,
        currency: true,
        lineItems: true,
        items: {
          select: {
            orderItemId: true,
            productId: true,
            productSku: true,
            productName: true,
            quantity: true,
            unitPrice: true,
            totalPrice: true,
          },
        },
        paymentMethod: true,
        paymentGatewayRef: true,
        paymentSlipUrl: true,
        status: true,
        pdfUrl: true,
        pdfStatus: true,
        pdfError: true,
        pdfAttemptCount: true,
        pdfUpdatedAt: true,
        verifiedBy: true,
        verifiedAt: true,
        rejectionReason: true,
        verificationNote: true,
        refundAmount: true,
        refundMethod: true,
        refundReason: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });

    return invoices.map(({ items, lineItems, ...invoice }) => ({
      ...invoice,
      pdfUrl: invoice.pdfUrl ? `/invoices/${invoice.id}/pdf` : null,
      lineItems: this.normalizeLineItems(lineItems, items),
    }));
  }
}

export default new InvoiceRepository();