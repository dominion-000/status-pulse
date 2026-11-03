-- Pro plan: 20,000 NGN = 2,000,000 kobo (Paystack minor units)
UPDATE plans
SET price_cents = 2000000
WHERE name = 'pro';
