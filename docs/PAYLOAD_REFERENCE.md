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
