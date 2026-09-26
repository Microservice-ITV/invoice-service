import prisma from '@/config/database';
import { Prisma } from '@prisma/client';
import { InvoiceFilters, InvoiceLineItem, InvoiceStatus } from '@/types/invoice';
import { OrderInvoiceSnapshotItem } from '@/services/order-snapshot.service';

export class InvoiceRepository {
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

  async createInvoice(data: {
    invoiceNumber: string;
    orderId: string;
    shopId: string;
    shopName?: string | null;
    customerId: string;
    customerName?: string | null;
    customerEmail?: string | null;
    subtotal: string;
    deliveryFee?: string;
    taxAmount: string;
    discountAmount: string;
    grandTotal: string;
    lineItems: InvoiceLineItem[];
    currency: string;
    paymentMethod: string | null;
    paymentGatewayRef: string | null;
    paymentSlipUrl: string | null;
    status: InvoiceStatus;
  }) {
    return prisma.invoice.create({
      data: {
        invoiceNumber: data.invoiceNumber,
        orderId: data.orderId,
        shopId: data.shopId,
        shopName: data.shopName,
        customerId: data.customerId,
        customerName: data.customerName,
        customerEmail: data.customerEmail,
        subtotal: data.subtotal,
        deliveryFee: data.deliveryFee ?? '0.00',
        taxAmount: data.taxAmount,
        discountAmount: data.discountAmount,
        grandTotal: data.grandTotal,
        currency: data.currency,
        paymentMethod: data.paymentMethod as string,
        paymentGatewayRef: data.paymentGatewayRef,
        paymentSlipUrl: data.paymentSlipUrl,
        status: data.status,
      },
    });
  }

  async findById(id: string) {
    return prisma.invoice.findUnique({
      where: { id },
    });
  }

  async findIdempotency(idempotencyKey: string) {
    return prisma.invoiceIdempotency.findUnique({
      where: { idempotencyKey },
      include: { invoice: { include: { items: true } } },
    });
  }

  async createPaidInvoiceFromPayment(data: {
    invoiceNumber: string;
    orderId: string;
    shopId: string;
    shopName: string | null;
    customerId: string;
    customerName: string | null;
    customerEmail: string | null;
    currency: string;
    subtotal: string;
    deliveryFee: string;
    taxAmount: string;
    discountAmount: string;
    grandTotal: string;
    paymentMethod: string | null;
    paymentGatewayRef: string;
    lineItems: InvoiceLineItem[];
    items: Array<OrderInvoiceSnapshotItem & { requestedQuantity: number }>;
    idempotencyKey: string;
    requestHash: string;
  }) {
    return prisma.$transaction(async (tx) => {
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
          invoiceNumber: data.invoiceNumber,
          orderId: data.orderId,
          shopId: data.shopId,
          shopName: data.shopName,
          customerId: data.customerId,
          customerName: data.customerName,
          customerEmail: data.customerEmail,
          lineItems: data.lineItems as unknown as Prisma.InputJsonValue,
          subtotal: data.subtotal,
          deliveryFee: data.deliveryFee,
          taxAmount: data.taxAmount,
          discountAmount: data.discountAmount,
          grandTotal: data.grandTotal,
          currency: data.currency,
          paymentMethod: data.paymentMethod,
          paymentGatewayRef: data.paymentGatewayRef,
          status: 'PAID',
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
    });
  }

  async createPartialInvoice(data: {
    invoiceNumber: string;
    orderId: string;
    shopId: string;
    customerId: string;
    customerName: string | null;
    customerEmail: string | null;
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
    return prisma.$transaction(async (tx) => {
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
          invoiceNumber: data.invoiceNumber,
          orderId: data.orderId,
          shopId: data.shopId,
          customerId: data.customerId,
          customerName: data.customerName,
          customerEmail: data.customerEmail,
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

  /**
   * Legacy order snapshot update.
   *
   * Since orderId is no longer unique, update the most recent invoice
   * belonging to the order.
   *
   * This is temporary compatibility behavior.
   * Partial-invoice flows should eventually update a specific invoice.
   */
  async updateOrderSnapshot(
    orderId: string,
    data: {
      shopName?: string | null;
      lineItems?: InvoiceLineItem[];
      customerName?: string | null;
      customerEmail?: string | null;
    },
  ) {
    const invoice = await prisma.invoice.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });

    if (!invoice) {
      return null;
    }

    return prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        ...(data.shopName !== undefined
          ? { shopName: data.shopName }
          : {}),
        ...(data.customerName !== undefined
          ? { customerName: data.customerName }
          : {}),
        ...(data.customerEmail !== undefined
          ? { customerEmail: data.customerEmail }
          : {}),
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

  async claimPdfGeneration(id: string): Promise<boolean> {
    const result = await prisma.invoice.updateMany({
      where: {
        id,
        pdfUrl: null,
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
        ...(filters.shopId ? { shopId: filters.shopId } : {}),
        ...(filters.customerId ? { customerId: filters.customerId } : {}),
        ...(filters.orderId ? { orderId: filters.orderId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      select: {
        id: true,
        invoiceNumber: true,
        orderId: true,
        shopId: true,
        shopName: true,
        customerId: true,
        customerName: true,
        customerEmail: true,
        subtotal: true,
        taxAmount: true,
        discountAmount: true,
        deliveryFee: true,
        grandTotal: true,
        currency: true,
        lineItems: true,
        items: {
          select: {
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
      lineItems: Array.isArray(lineItems) && lineItems.length > 0
        ? lineItems
        : items.map((item) => ({
          name: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice.toString(),
          total: item.totalPrice.toString(),
        })),
    }));
  }
}

export default new InvoiceRepository();