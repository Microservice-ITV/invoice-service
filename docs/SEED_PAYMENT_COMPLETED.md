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

The default event uses the seeded `main-store` shop and creates a paid invoice for `105000.00 MMK`. The default order ID is deterministic, so running the command again will not create a duplicate invoice.

Override values when needed:

```bash
SEED_ORDER_ID=11111111-1111-4111-8111-111111111111 \
SEED_SHOP_ID=00468bc2-856e-4852-9e38-2609acb7e6cd \
SEED_PAYMENT_METHOD=MANUAL_SLIP \
SEED_GRAND_TOTAL=125000.00 \
npm run seed:payment-completed
```

Verify the event in the invoice logs:

```bash
docker compose logs -f invoice-service
```