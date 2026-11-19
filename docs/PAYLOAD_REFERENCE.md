# Invoice Service Payload Reference

## Payment Completed Event

This service consumes the `payment.completed` event from RabbitMQ.

```json
{
  "eventId": "evt_123",
  "orderId": "a0f3f0a5-39cc-4d7f-b7d1-bb4d9b4a8d52",
  "shopId": "4f7ea086-6d16-49f6-9a8d-34dfd8d5d52f",
  "customerId": "7d78b4ad-0822-4aa6-bec4-3e912ef5db52",
  "paymentMethod": "MANUAL_SLIP",
  "paymentGatewayRef": "gateway_ref_123",
  "paymentSlipUrl": "https://example.com/slip/123.png",
  "currency": "MMK",
  "subtotal": "250000.00",
  "taxAmount": "25000.00",
  "discountAmount": "5000.00",
  "grandTotal": "270000.00"
}
```

## `order.paid` Invoice Retries and Dead Letters

Invoice creation failures on the `order.paid` queue receive at most five total
attempts. Transient failures are handed to durable retry queues with delays of
1, 2, 4, and 8 seconds; invalid or ineligible messages go directly to the
durable dead-letter queue. After the fifth failed attempt, the event is also
sent to the dead-letter queue.

Queue names are derived from `RABBITMQ_ORDER_PAID_QUEUE`:

- `<queue>.retry.1` through `<queue>.retry.4`
- `<queue>.dlq`

Retry queues dead-letter back to `RABBITMQ_EXCHANGE` using
`RABBITMQ_ORDER_PAID_KEY`. DLQ messages contain the original body (including an
exact base64 copy), order ID, error details, first and final failure
timestamps, and attempt counts. The source delivery is acknowledged only after
invoice creation succeeds or a confirmed retry/DLQ handoff completes.

The existing source queue remains durable and is declared without additional
arguments, so deploying this feature does not require changing or recreating
production queues. The service declares only the new retry and DLQ queues at
startup; RabbitMQ credentials must allow queue declaration and message
publishing. No database migration or frontend change is required.

## Invoice Verification Payload

```json
{
  "approved": true,
  "reason": "Optional rejection explanation"
}
```

## Invoice API Response Envelope

Success:

```json
{
  "success": true,
  "data": {
    "id": "...",
    "invoiceNumber": "INV-20260915-00001",
    "status": "PENDING_VERIFICATION"
  }
}
```

Error:

```json
{
  "success": false,
  "message": "Invoice not found"
}
```
