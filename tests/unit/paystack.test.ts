import { describe, expect, it } from "vitest";
import { processPlanPayment } from "../../src/payments/paystack";

describe("processPlanPayment", () => {
  const base = {
    email: "owner@example.com",
    amountCents: 50000,
    reference: "ref-1",
    planName: "pro",
  };

  it("succeeds in test env without a Paystack key", async () => {
    const r = await processPlanPayment(base, {
      failPayments: false,
      env: { NODE_ENV: "test" },
    });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("test");
  });

  it("fails closed without a key outside test env", async () => {
    const r = await processPlanPayment(base, {
      failPayments: false,
      env: { NODE_ENV: "production" },
    });
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/PAYSTACK_SECRET_KEY/);
  });

  it("honours failPayments", async () => {
    const r = await processPlanPayment(base, {
      failPayments: true,
      env: { NODE_ENV: "test" },
    });
    expect(r.ok).toBe(false);
  });

  it("calls Paystack when a secret key is present", async () => {
    const r = await processPlanPayment(base, {
      failPayments: false,
      env: { PAYSTACK_SECRET_KEY: "sk_test_x", NODE_ENV: "production" },
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            status: true,
            data: { reference: "psk_ref" },
          }),
        }) as Response) as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("paystack");
    expect(r.reference).toBe("psk_ref");
  });
});
