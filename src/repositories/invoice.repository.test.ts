import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'mysql://invoice:invoice@localhost:3306/invoice_test';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.LOG_LEVEL = 'error';

import { InvoiceRepository } from '@/repositories/invoice.repository';

interface StoredInvoice {
  id: string;
  invoiceNumber: string;
  orderId: string;
  orderReference: string;
  [key: string]: unknown;
}

interface MemoryStore {
  invoiceCounters: Map<string, number>;
  orderReferenceCounters: Map<string, number>;
  orderReferences: Map<string, { id: number; orderId: string; orderReference: string }>;
  idempotency: Map<string, { requestHash: string; invoice: StoredInvoice }>;
  invoices: StoredInvoice[];
}

const createStore = (): MemoryStore => ({
  invoiceCounters: new Map(),
  orderReferenceCounters: new Map(),
  orderReferences: new Map(),
  idempotency: new Map(),
  invoices: [],
});

const createTransaction = (store: MemoryStore): Prisma.TransactionClient => {
  let nextOrderReferenceId = 1;
  let nextInvoiceId = 1;

  const transaction = {
    invoiceNumberSequence: {
      upsert: async (args: {
        where: { date: string };
        update: { lastNumber: { increment: number } };
        create: { date: string; lastNumber: number };
      }) => {
        const current = store.invoiceCounters.get(args.where.date);
        const lastNumber = current === undefined
          ? args.create.lastNumber
          : current + args.update.lastNumber.increment;
        store.invoiceCounters.set(args.where.date, lastNumber);
        return { date: args.where.date, lastNumber };
      },
    },
    orderReferenceSequence: {
      upsert: async (args: {
        where: { date: string };
        update: { lastNumber: { increment: number } };
        create: { date: string; lastNumber: number };
      }) => {
        const current = store.orderReferenceCounters.get(args.where.date);
        const lastNumber = current === undefined
          ? args.create.lastNumber
          : current + args.update.lastNumber.increment;
        store.orderReferenceCounters.set(args.where.date, lastNumber);
        return { date: args.where.date, lastNumber };
      },
    },
    invoiceOrderReference: {
      findUnique: async (args: { where: { orderId: string } }) => (
        store.orderReferences.get(args.where.orderId) ?? null
      ),
      create: async (args: {
        data: { orderId: string; orderReference: string };
        select?: { id?: boolean; orderReference?: boolean };
      }) => {
        const reference = {
          id: nextOrderReferenceId,
          ...args.data,
        };
        nextOrderReferenceId += 1;
        store.orderReferences.set(reference.orderId, reference);
        return args.select?.id
          ? { id: reference.id }
          : { orderReference: reference.orderReference };
      },
      update: async (args: { where: { id: number }; data: { orderReference: string } }) => {
        const reference = [...store.orderReferences.values()].find((item) => item.id === args.where.id);
        if (!reference) throw new Error('Order reference not found');
        reference.orderReference = args.data.orderReference;
        return reference;
      },
    },
    invoiceIdempotency: {
      findUnique: async (args: { where: { idempotencyKey: string } }) => (
        store.idempotency.get(args.where.idempotencyKey) ?? null
      ),
      create: async (args: {
        data: { idempotencyKey: string; requestHash: string; invoiceId: string };
      }) => {
        const invoice = store.invoices.find((item) => item.id === args.data.invoiceId);
        if (!invoice) throw new Error('Invoice not found');
        store.idempotency.set(args.data.idempotencyKey, {
          requestHash: args.data.requestHash,
          invoice,
        });
        return invoice;
      },
    },
    invoiceOrderItemAllocation: {},
    invoice: {
      create: async (args: { data: Record<string, unknown> }) => {
        const invoice = {
          ...args.data,
          id: `invoice-${nextInvoiceId}`,
          invoiceNumber: String(args.data.invoiceNumber),
          orderId: String(args.data.orderId),
          orderReference: String(args.data.orderReference),
          items: [],
        } satisfies StoredInvoice;
        nextInvoiceId += 1;
        store.invoices.push(invoice);
        return invoice;
      },
    },
    thermalPdfJob: {
      createMany: async () => ({ count: 0 }),
    },
    $queryRaw: async () => [],
  };

  return transaction as unknown as Prisma.TransactionClient;
};

const runWithStore = async <T>(
  store: MemoryStore,
  operation: (repository: InvoiceRepository) => Promise<T>,
  now: () => Date = () => new Date('2026-11-12T10:00:00.000Z'),
): Promise<T> => {
  const transaction = createTransaction(store);
  const runTransaction = async <R>(callback: (tx: Prisma.TransactionClient) => Promise<R>): Promise<R> => (
    callback(transaction)
  );
  return operation(new InvoiceRepository(now, runTransaction));
};

const paidInvoiceInput = (orderId: string, idempotencyKey: string) => ({
  orderId,
  shopId: 'shop-1',
  shopName: null,
  customerId: 'customer-1',
  customerName: null,
  customerEmail: null,
  customerPhone: null,
  billingAddress: {},
  shippingAddress: {},
  shopContactName: null,
  shopContactEmail: null,
  shopContactPhone: null,
  shopAddress: null,
  currency: 'MMK',
  subtotal: '100.00',
  deliveryFee: '0.00',
  taxAmount: '0.00',
  discountAmount: '0.00',
  grandTotal: '100.00',
  paymentMethod: 'COD',
  paymentGatewayRef: null,
  lineItems: [],
  items: [],
  idempotencyKey,
  requestHash: `hash-${idempotencyKey}`,
});

const partialInvoiceInput = (orderId: string, idempotencyKey: string) => ({
  orderId,
  shopId: 'shop-1',
  shopName: null,
  customerId: 'customer-1',
  customerName: null,
  customerEmail: null,
  customerPhone: null,
  billingAddress: {},
  shippingAddress: {},
  shopContactName: null,
  shopContactEmail: null,
  shopContactPhone: null,
  shopAddress: null,
  currency: 'MMK',
  paymentMethod: null,
  subtotal: '100.00',
  taxAmount: '0.00',
  discountAmount: '0.00',
  grandTotal: '100.00',
  items: [],
  idempotencyKey,
  requestHash: `hash-${idempotencyKey}`,
});

test('paid and partial invoices allocate independent invoice and order-reference numbers', async () => {
  const store = createStore();
  await runWithStore(store, async (repository) => {
    const paid = await repository.createPaidInvoiceFromPayment(paidInvoiceInput('order-1', 'paid-1'));
    const secondPaid = await repository.createPaidInvoiceFromPayment(paidInvoiceInput('order-2', 'paid-2'));
    const sameOrderPaid = await repository.createPaidInvoiceFromPayment({
      ...paidInvoiceInput('order-1', 'paid-1-again'),
      orderReference: 'ORD-should-not-replace-existing',
    });
    const partial = await repository.createPartialInvoice(partialInvoiceInput('order-3', 'partial-1'));

    assert.deepEqual(
      [paid.invoiceNumber, secondPaid.invoiceNumber, sameOrderPaid.invoiceNumber, partial.invoiceNumber],
      ['INV-20261112-000001', 'INV-20261112-000002', 'INV-20261112-000003', 'INV-20261112-000004'],
    );
    assert.deepEqual(
      [paid.orderReference, secondPaid.orderReference, sameOrderPaid.orderReference, partial.orderReference],
      ['ORD-20261112-000001', 'ORD-20261112-000002', 'ORD-20261112-000001', 'ORD-20261112-000003'],
    );
  });
});

test('same-order invoices reuse their order reference and idempotent retries consume no numbers', async () => {
  const store = createStore();
  await runWithStore(store, async (repository) => {
    const first = await repository.createPartialInvoice(partialInvoiceInput('order-same', 'partial-retry'));
    const retry = await repository.createPartialInvoice(partialInvoiceInput('order-same', 'partial-retry'));
    const second = await repository.createPartialInvoice(partialInvoiceInput('order-same', 'partial-again'));
    const nextOrder = await repository.createPartialInvoice(partialInvoiceInput('order-next', 'partial-next'));

    assert.equal(retry.id, first.id);
    assert.equal(second.invoiceNumber, 'INV-20261112-000002');
    assert.equal(second.orderReference, first.orderReference);
    assert.equal(nextOrder.invoiceNumber, 'INV-20261112-000003');
    assert.equal(nextOrder.orderReference, 'ORD-20261112-000002');
  });
});

test('concurrent invoice transactions allocate unique consecutive values in each sequence', async () => {
  const store = createStore();
  await runWithStore(store, async (repository) => {
    const invoices = await Promise.all(
      Array.from({ length: 20 }, (_, index) => (
        repository.createPartialInvoice(partialInvoiceInput(`order-${index}`, `partial-${index}`))
      )),
    );

    const invoiceNumbers = invoices.map((invoice) => invoice.invoiceNumber).sort();
    const orderReferences = invoices.map((invoice) => invoice.orderReference).sort();
    assert.deepEqual(
      invoiceNumbers,
      Array.from({ length: 20 }, (_, index) => `INV-20261112-${String(index + 1).padStart(6, '0')}`),
    );
    assert.deepEqual(
      orderReferences,
      Array.from({ length: 20 }, (_, index) => `ORD-20261112-${String(index + 1).padStart(6, '0')}`),
    );
  });
});

test('invoice and order-reference sequences restart independently when the UTC date changes', async () => {
  const store = createStore();
  let now = new Date('2026-11-12T23:59:59.000Z');
  await runWithStore(store, async (repository) => {
    const beforeMidnight = await repository.createPaidInvoiceFromPayment(paidInvoiceInput('order-before', 'paid-before'));
    now = new Date('2026-11-13T00:00:00.000Z');
    const afterMidnight = await repository.createPartialInvoice(partialInvoiceInput('order-after', 'partial-after'));

    assert.equal(beforeMidnight.invoiceNumber, 'INV-20261112-000001');
    assert.equal(beforeMidnight.orderReference, 'ORD-20261112-000001');
    assert.equal(afterMidnight.invoiceNumber, 'INV-20261113-000001');
    assert.equal(afterMidnight.orderReference, 'ORD-20261113-000001');
  }, () => now);
});
