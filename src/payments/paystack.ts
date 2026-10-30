/**
 * Plan-upgrade payments via Paystack (test or live secret key).
 * Outside automated tests, PAYSTACK_SECRET_KEY is required for a successful charge path.
 * Tests may omit the key and get a local success (or failure when failPayments is true).
 */

export interface PaymentRequest {
  email: string;
  amountCents: number;
  reference: string;
  planName: string;
}

export interface PaymentResult {
  ok: boolean;
  provider: "paystack" | "test";
  reference: string;
  errorMessage?: string;
  providerResponse?: unknown;
}

function isTestEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === "test" ||
    env.VITEST === "true" ||
    env.PAYMENT_PROVIDER === "test"
  );
}

export async function processPlanPayment(
  req: PaymentRequest,
  opts: {
    failPayments: boolean;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  },
): Promise<PaymentResult> {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchImpl ?? fetch;

  if (opts.failPayments) {
    return {
      ok: false,
      provider: isTestEnv(env) ? "test" : "paystack",
      reference: req.reference,
      errorMessage: "Payment failed (failPayments)",
    };
  }

  const secret = (env.PAYSTACK_SECRET_KEY ?? "").trim();

  if (!secret) {
    if (isTestEnv(env)) {
      return { ok: true, provider: "test", reference: req.reference };
    }
    return {
      ok: false,
      provider: "paystack",
      reference: req.reference,
      errorMessage: "PAYSTACK_SECRET_KEY is not configured",
    };
  }

  const currency = (env.PAYSTACK_CURRENCY ?? "NGN").trim() || "NGN";

  try {
    const res = await fetchFn(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: req.email,
          amount: req.amountCents,
          reference: req.reference,
          currency,
          metadata: { planName: req.planName },
        }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      status?: boolean;
      message?: string;
      data?: { reference?: string; authorization_url?: string };
    };
    if (!res.ok || body.status !== true) {
      return {
        ok: false,
        provider: "paystack",
        reference: req.reference,
        errorMessage: body.message ?? `Paystack HTTP ${res.status}`,
        providerResponse: body,
      };
    }
    return {
      ok: true,
      provider: "paystack",
      reference: body.data?.reference ?? req.reference,
      providerResponse: body.data,
    };
  } catch (err) {
    return {
      ok: false,
      provider: "paystack",
      reference: req.reference,
      errorMessage:
        err instanceof Error ? err.message : "Paystack request failed",
    };
  }
}
