/**
 * Plan-upgrade payments via Paystack (test or live secret key).
 * Flow: initialize → customer pays on authorization_url → verify before upgrading.
 * Automated tests may use PAYMENT_PROVIDER=test for an in-process success/failure.
 */

export interface PaymentRequest {
  email: string;
  amountCents: number;
  reference: string;
  planName: string;
  callbackUrl?: string;
}

export interface PaymentResult {
  ok: boolean;
  /** True when the customer still needs to complete Paystack checkout. */
  pendingCheckout?: boolean;
  provider: "paystack" | "test";
  reference: string;
  authorizationUrl?: string;
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
      errorMessage: "Payment failed (PAYMENT_FAIL_ALL)",
    };
  }

  // Free plan / zero amount: no charge.
  if (req.amountCents <= 0) {
    return {
      ok: true,
      pendingCheckout: false,
      provider: isTestEnv(env) ? "test" : "paystack",
      reference: req.reference,
    };
  }

  if (isTestEnv(env)) {
    return {
      ok: true,
      pendingCheckout: false,
      provider: "test",
      reference: req.reference,
    };
  }

  const secret = (env.PAYSTACK_SECRET_KEY ?? "").trim();
  if (!secret) {
    return {
      ok: false,
      provider: "paystack",
      reference: req.reference,
      errorMessage: "PAYSTACK_SECRET_KEY is not configured",
    };
  }

  const currency = (env.PAYSTACK_CURRENCY ?? "NGN").trim() || "NGN";

  try {
    const res = await fetchFn("https://api.paystack.co/transaction/initialize", {
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
        callback_url: req.callbackUrl,
        metadata: { planName: req.planName },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      status?: boolean;
      message?: string;
      data?: { reference?: string; authorization_url?: string };
    };
    if (!res.ok || body.status !== true || !body.data?.authorization_url) {
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
      pendingCheckout: true,
      provider: "paystack",
      reference: body.data.reference ?? req.reference,
      authorizationUrl: body.data.authorization_url,
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

/** Confirm a Paystack charge before applying a plan upgrade. */
export async function verifyPlanPayment(
  reference: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<PaymentResult> {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchImpl ?? fetch;

  if (isTestEnv(env)) {
    return {
      ok: true,
      pendingCheckout: false,
      provider: "test",
      reference,
    };
  }

  const secret = (env.PAYSTACK_SECRET_KEY ?? "").trim();
  if (!secret) {
    return {
      ok: false,
      provider: "paystack",
      reference,
      errorMessage: "PAYSTACK_SECRET_KEY is not configured",
    };
  }

  try {
    const res = await fetchFn(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${secret}` },
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      status?: boolean;
      message?: string;
      data?: { status?: string; reference?: string; amount?: number };
    };
    const paid =
      res.ok &&
      body.status === true &&
      (body.data?.status === "success" || body.data?.status === "successful");
    if (!paid) {
      return {
        ok: false,
        provider: "paystack",
        reference,
        errorMessage: body.message ?? `Payment not successful (${body.data?.status ?? res.status})`,
        providerResponse: body,
      };
    }
    return {
      ok: true,
      pendingCheckout: false,
      provider: "paystack",
      reference: body.data?.reference ?? reference,
      providerResponse: body.data,
    };
  } catch (err) {
    return {
      ok: false,
      provider: "paystack",
      reference,
      errorMessage:
        err instanceof Error ? err.message : "Paystack verify failed",
    };
  }
}
