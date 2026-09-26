# Seed a payment.completed event

This command publishes one `payment.completed` event from the invoice service to RabbitMQ. The invoice consumer receives it and creates the invoice through the normal event flow.

Run it from the invoice service directory after the containers are running:

```bash
npm run seed:payment-completed
```

Inside the container:

```bash
docker compose exec invoice-service npm run seed:payment-completed
```

The default event uses the seeded `main-store` shop and requests a paid invoice for `105000.00 MMK`. The order ID must exist in the order service and its invoice snapshot total must match the event amount. The payment and transaction IDs are unique by default, so each successful run creates a new invoice.

Override values when needed:

```bash
SEED_ORDER_ID=11111111-1111-4111-8111-111111111111 \
SEED_AMOUNT=125000.00 \
SEED_SHOP_NAME="Main Store" \
npm run seed:payment-completed
```

Verify the event in the invoice logs:

```bash
docker compose logs -f invoice-service
```