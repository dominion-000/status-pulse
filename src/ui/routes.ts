import { randomBytes } from "node:crypto";
import { Router } from "express";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import {
  isIncidentPublic,
  isUpdatePublic,
  type IncidentStatus,
} from "../core/incident";
import {
  createVerificationToken,
  exposeVerificationToken,
  hashToken,
} from "../core/tokens";
import { upgradePlan } from "../db/plans";
import { rateLimit, subscribeRateLimitStore } from "../middleware/rate-limit";
import { systemClock } from "../core/clock";
import { hashPassword, verifyPassword } from "../core/password";
import { signAccessToken } from "../auth/tokens";
import { clearTokenCookie, readUserId, setTokenCookie } from "./auth-cookie";
import { renderPage } from "./render";

function appNav(active: string) {
  return [
    { href: "/app", label: "Home", active: active === "home" },
    { href: "/app/projects", label: "Projects", active: active === "projects" },
    { href: "/app/logout", label: "Sign out", active: false },
  ];
}

function publicNav(slug: string) {
  return [
    { href: `/status/${slug}`, label: "Status", active: true },
    { href: `/status/${slug}/subscribe`, label: "Subscribe", active: false },
  ];
}

function parseBody(req: { body?: unknown }): Record<string, unknown> {
  return (req.body && typeof req.body === "object"
    ? (req.body as Record<string, unknown>)
    : {}) as Record<string, unknown>;
}

/**
 * Browser UI routes (EJS). API remains JSON under /auth, /projects, /public.
 */
// The browser forms share the API's limit: they reach the same accounts and the same subscribe endpoint.
const uiLimit = rateLimit({ name: "subscribe", store: subscribeRateLimitStore });

// Fixed messages for the redirect codes, so a crafted link cannot put its own text on the page.
const PLAN_ERRORS: Record<string, string> = {
  payment_failed: "The payment failed. The plan is unchanged.",
  key_conflict: "That Idempotency-Key was already used for a different plan.",
  unknown_plan: "Unknown plan.",
};

export function uiRoutes(prisma: PrismaClient, config: Config): Router {
  const r = Router();

  // --- Public status & subscribe ---

  r.get("/status/:slug", async (req, res, next) => {
    try {
      const slug = String(req.params.slug);
      const project = await prisma.project.findUnique({
        where: { slug },
        select: {
          name: true,
          slug: true,
          services: {
            where: { isPublic: true, enabled: true, deletedAt: null },
            orderBy: { name: "asc" },
            select: {
              id: true,
              name: true,
              currentStatus: true,
              statusSince: true,
              lastResultAt: true,
              isPublic: true,
              incidents: {
                where: { status: { not: "Resolved" } },
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                  id: true,
                  title: true,
                  status: true,
                  isPublic: true,
                  createdAt: true,
                  updates: {
                    orderBy: { createdAt: "asc" },
                    take: 20,
                    select: {
                      id: true,
                      status: true,
                      message: true,
                      isPublic: true,
                      createdAt: true,
                    },
                  },
                },
              },
              statusHistory: {
                orderBy: { startedAt: "desc" },
                take: 20,
                select: { status: true, startedAt: true },
              },
            },
          },
        },
      });
      if (!project) {
        return renderPage(res, "public/status", {
          title: "Not found",
          error: "Project not found",
          project: { name: "Unknown", slug },
          services: [],
          brandHref: "/",
          nav: [],
        }, 404);
      }

      const services = project.services.map((s) => {
        const raw = s.incidents[0] ?? null;
        const incidentPublic =
          raw && isIncidentPublic(raw.isPublic, s.isPublic);
        return {
          id: s.id,
          name: s.name,
          currentStatus: s.currentStatus,
          statusSince: s.statusSince.toISOString(),
          lastResultAt: s.lastResultAt ? s.lastResultAt.toISOString() : null,
          activeIncident: incidentPublic
            ? {
                id: raw!.id,
                title: raw!.title,
                status: raw!.status as IncidentStatus,
                createdAt: raw!.createdAt.toISOString(),
                updates: raw!.updates
                  .filter((u) =>
                    isUpdatePublic(u.isPublic, raw!.isPublic, s.isPublic),
                  )
                  .map((u) => ({
                    message: u.message,
                    createdAt: u.createdAt.toISOString(),
                  })),
              }
            : null,
          recentHistory: s.statusHistory.map((h) => ({
            status: h.status,
            startedAt: h.startedAt.toISOString(),
          })),
        };
      });

      renderPage(res, "public/status", {
        title: project.name,
        project: { name: project.name, slug: project.slug },
        services,
        brandHref: `/status/${slug}`,
        nav: publicNav(slug),
      });
    } catch (err) {
      next(err);
    }
  });

  r.get("/status/:slug/subscribe", async (req, res, next) => {
    try {
      const slug = String(req.params.slug);
      const project = await prisma.project.findUnique({
        where: { slug },
        select: {
          name: true,
          slug: true,
          services: {
            where: { isPublic: true, enabled: true, deletedAt: null },
            orderBy: { name: "asc" },
            select: { id: true, name: true },
          },
        },
      });
      if (!project) {
        return renderPage(res, "public/subscribe", {
          title: "Subscribe",
          error: "Project not found",
          project: { name: "Unknown", slug },
          services: [],
          brandHref: "/",
          nav: [],
        }, 404);
      }
      renderPage(res, "public/subscribe", {
        title: "Subscribe",
        project,
        services: project.services,
        brandHref: `/status/${slug}`,
        nav: publicNav(slug),
      });
    } catch (err) {
      next(err);
    }
  });

  r.post("/status/:slug/subscribe", uiLimit, async (req, res, next) => {
    try {
      const slug = String(req.params.slug);
      const body = parseBody(req);
      const email = String(body.email ?? "").trim().toLowerCase();
      let serviceIds = body.serviceIds;
      if (typeof serviceIds === "string") serviceIds = [serviceIds];
      if (!Array.isArray(serviceIds)) serviceIds = [];
      const ids = (serviceIds as unknown[]).map(String);

      const project = await prisma.project.findUnique({
        where: { slug },
        select: { id: true, name: true, slug: true },
      });
      if (!project || !email) {
        return renderPage(res, "public/subscribe", {
          title: "Subscribe",
          error: "Invalid project or email",
          project: project ?? { name: "Unknown", slug },
          services: [],
          brandHref: "/",
          nav: [],
        }, 400);
      }

      const publicServices = await prisma.service.findMany({
        where: {
          projectId: project.id,
          id: { in: ids },
          isPublic: true,
          enabled: true,
          deletedAt: null,
        },
        select: { id: true, name: true },
      });

      if (!publicServices.length) {
        return renderPage(res, "public/subscribe", {
          title: "Subscribe",
          error: "Select at least one public service",
          project,
          services: await prisma.service.findMany({
            where: {
              projectId: project.id,
              isPublic: true,
              enabled: true,
              deletedAt: null,
            },
            select: { id: true, name: true },
          }),
          brandHref: `/status/${slug}`,
          nav: publicNav(slug),
        }, 400);
      }

      const now = systemClock.now();
      const { raw, hash } = createVerificationToken();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      await prisma.$transaction(async (tx) => {
        let subscriber = await tx.subscriber.findUnique({
          where: {
            projectId_email: { projectId: project.id, email },
          },
        });
        // Match API: verified address — no service changes, no confirmation.
        if (subscriber?.verifiedAt) {
          return;
        }
        if (!subscriber) {
          subscriber = await tx.subscriber.create({
            data: {
              projectId: project.id,
              email,
              verificationTokenHash: hash,
              verificationExpiresAt: expiresAt,
            },
          });
        } else {
          subscriber = await tx.subscriber.update({
            where: { id: subscriber.id },
            data: {
              verificationTokenHash: hash,
              verificationExpiresAt: expiresAt,
            },
          });
        }
        for (const svc of publicServices) {
          await tx.subscriberService.upsert({
            where: {
              subscriberId_serviceId: {
                subscriberId: subscriber.id,
                serviceId: svc.id,
              },
            },
            create: { subscriberId: subscriber.id, serviceId: svc.id },
            update: {},
          });
        }
        const names = publicServices.map((s) => s.name).join(", ");
        await tx.outboxMessage.create({
          data: {
            projectId: project.id,
            kind: "subscription_verification",
            recipientEmail: email,
            subject: `Verify your subscription to ${project.name}`,
            body: `Confirm subscription to ${names}. Token: ${raw}`,
          },
        });
      });

      renderPage(res, "public/subscribe", {
        title: "Subscribe",
        project,
        services: publicServices,
        done: true,
        verificationToken: exposeVerificationToken() ? raw : undefined,
        brandHref: `/status/${slug}`,
        nav: publicNav(slug),
      });
    } catch (err) {
      next(err);
    }
  });

  r.get("/status/:slug/verify", (req, res) => {
    const slug = String(req.params.slug);
    renderPage(res, "public/verify", {
      title: "Verify",
      brandHref: `/status/${slug}`,
      nav: publicNav(slug),
    });
  });

  r.get("/status/verify", (_req, res) => {
    renderPage(res, "public/verify", {
      title: "Verify",
      brandHref: "/",
      nav: [],
    });
  });

  r.post("/status/verify", async (req, res, next) => {
    try {
      const token = String(parseBody(req).token ?? "");
      const hash = hashToken(token);
      const now = systemClock.now();
      const subscriber = await prisma.subscriber.findFirst({
        where: { verificationTokenHash: hash },
      });
      if (
        !subscriber ||
        !subscriber.verificationExpiresAt ||
        subscriber.verificationExpiresAt.getTime() < now.getTime() ||
        subscriber.verifiedAt
      ) {
        return renderPage(res, "public/verify", {
          title: "Verify",
          error: "Token is invalid or already used",
          brandHref: "/",
          nav: [],
        }, 410);
      }
      const claimed = await prisma.subscriber.updateMany({
        where: {
          id: subscriber.id,
          verificationTokenHash: hash,
          verifiedAt: null,
          verificationExpiresAt: { gte: now },
        },
        data: {
          verifiedAt: now,
          verificationTokenHash: null,
          verificationExpiresAt: null,
        },
      });
      if (claimed.count !== 1) {
        return renderPage(res, "public/verify", {
          title: "Verify",
          error: "Token is invalid or already used",
          brandHref: "/",
          nav: [],
        }, 410);
      }
      renderPage(res, "public/verify", {
        title: "Verify",
        verified: true,
        email: subscriber.email,
        brandHref: "/",
        nav: [],
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Auth ---

  r.get("/app/login", (req, res) => {
    if (readUserId(req, config)) return res.redirect("/app");
    renderPage(res, "auth/login", {
      title: "Sign in",
      brandHref: "/app/login",
      nav: [{ href: "/app/register", label: "Register", active: false }],
    });
  });

  r.post("/app/login", uiLimit, async (req, res, next) => {
    try {
      const body = parseBody(req);
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const user = await prisma.user.findUnique({ where: { email } });
      const ok =
        user && (await verifyPassword(password, user.passwordHash));
      if (!ok || !user) {
        return renderPage(res, "auth/login", {
          title: "Sign in",
          error: "Invalid email or password",
          brandHref: "/app/login",
          nav: [{ href: "/app/register", label: "Register", active: false }],
        }, 401);
      }
      const token = signAccessToken(
        user.id,
        config.jwtSecret,
        config.accessTokenTtlSeconds,
      );
      setTokenCookie(res, token, config.accessTokenTtlSeconds);
      res.redirect("/app");
    } catch (err) {
      next(err);
    }
  });

  r.get("/app/register", (req, res) => {
    if (readUserId(req, config)) return res.redirect("/app");
    renderPage(res, "auth/register", {
      title: "Register",
      brandHref: "/app/register",
      nav: [{ href: "/app/login", label: "Sign in", active: false }],
    });
  });

  r.post("/app/register", uiLimit, async (req, res, next) => {
    try {
      const body = parseBody(req);
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      if (password.length < 8) {
        return renderPage(res, "auth/register", {
          title: "Register",
          error: "Password must be at least 8 characters",
          brandHref: "/app/register",
          nav: [{ href: "/app/login", label: "Sign in", active: false }],
        }, 400);
      }
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return renderPage(res, "auth/register", {
          title: "Register",
          error: "Email already registered",
          brandHref: "/app/register",
          nav: [{ href: "/app/login", label: "Sign in", active: false }],
        }, 409);
      }
      const passwordHash = await hashPassword(password);
      const user = await prisma.user.create({
        data: { email, passwordHash },
      });
      const token = signAccessToken(
        user.id,
        config.jwtSecret,
        config.accessTokenTtlSeconds,
      );
      setTokenCookie(res, token, config.accessTokenTtlSeconds);
      res.redirect("/app");
    } catch (err) {
      next(err);
    }
  });

  r.post("/app/logout", (_req, res) => {
    clearTokenCookie(res);
    res.redirect("/app/login");
  });
  // GET kept as redirect-only hint; does not clear the session.
  r.get("/app/logout", (_req, res) => {
    res.redirect("/app");
  });

  // --- Authenticated app ---

  async function requireUiUser(req: Parameters<typeof readUserId>[0]) {
    const userId = readUserId(req, config);
    if (!userId) return null;
    return prisma.user.findUnique({ where: { id: userId } });
  }

  r.get("/app", async (req, res, next) => {
    try {
      const user = await requireUiUser(req);
      if (!user) return res.redirect("/app/login");
      renderPage(res, "app/home", {
        title: "Dashboard",
        user: { email: user.email },
        brandHref: "/app",
        nav: appNav("home"),
      });
    } catch (err) {
      next(err);
    }
  });

  r.get("/app/projects", async (req, res, next) => {
    try {
      const user = await requireUiUser(req);
      if (!user) return res.redirect("/app/login");
      const memberships = await prisma.membership.findMany({
        where: { userId: user.id },
        include: { project: true },
        orderBy: { createdAt: "desc" },
      });
      renderPage(res, "app/projects", {
        title: "Projects",
        user: { email: user.email },
        projects: memberships.map((m) => ({
          id: m.project.id,
          name: m.project.name,
          slug: m.project.slug,
          role: m.role,
        })),
        brandHref: "/app",
        nav: appNav("projects"),
      });
    } catch (err) {
      next(err);
    }
  });

  r.get("/app/projects/:projectId", async (req, res, next) => {
    try {
      const user = await requireUiUser(req);
      if (!user) return res.redirect("/app/login");
      const projectId = String(req.params.projectId);
      const membership = await prisma.membership.findUnique({
        where: {
          projectId_userId: { projectId, userId: user.id },
        },
      });
      if (!membership) {
        return renderPage(res, "app/projects", {
          title: "Projects",
          error: "Project not found",
          user: { email: user.email },
          projects: [],
          brandHref: "/app",
          nav: appNav("projects"),
        }, 404);
      }
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        include: { plan: true },
      });
      const services = await prisma.service.findMany({
        where: { projectId, deletedAt: null },
        orderBy: { name: "asc" },
      });
      const incidents = await prisma.incident.findMany({
        where: { projectId, status: { not: "Resolved" } },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      renderPage(res, "app/project", {
        title: project.name,
        user: { email: user.email },
        project: {
          id: project.id,
          name: project.name,
          slug: project.slug,
        },
        plan: { name: project.plan.name },
        services: services.map((s) => ({
          id: s.id,
          name: s.name,
          currentStatus: s.currentStatus,
          isPublic: s.isPublic,
          enabled: s.enabled,
        })),
        incidents: incidents.map((i) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          createdAt: i.createdAt.toISOString(),
        })),
        brandHref: "/app",
        nav: appNav("projects"),
      });
    } catch (err) {
      next(err);
    }
  });

  r.get("/app/projects/:projectId/alerts", async (req, res, next) => {
    try {
      const user = await requireUiUser(req);
      if (!user) return res.redirect("/app/login");
      const projectId = String(req.params.projectId);
      const membership = await prisma.membership.findUnique({
        where: {
          projectId_userId: { projectId, userId: user.id },
        },
      });
      if (!membership || membership.role === "Viewer") {
        return res.redirect("/app/projects");
      }
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
      });
      const alerts = await prisma.alert.findMany({
        where: { projectId },
        include: {
          acknowledgement: true,
          messages: { orderBy: { recipientEmail: "asc" } },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      renderPage(res, "app/alerts", {
        title: "Alerts",
        user: { email: user.email },
        project: { id: project.id, name: project.name },
        alerts: alerts.map((a) => ({
          id: a.id,
          state: a.state,
          createdAt: a.createdAt.toISOString(),
          acknowledgement: a.acknowledgement
            ? { id: a.acknowledgement.id }
            : null,
          messages: a.messages.map((m) => ({
            recipientEmail: m.recipientEmail,
            attempts: m.attempts,
            deliveredAt: m.deliveredAt ? m.deliveredAt.toISOString() : null,
            lastError: m.lastError,
          })),
        })),
        brandHref: "/app",
        nav: appNav("projects"),
      });
    } catch (err) {
      next(err);
    }
  });

  r.post(
    "/app/projects/:projectId/alerts/:alertId/acknowledge",
    async (req, res, next) => {
      try {
        const user = await requireUiUser(req);
        if (!user) return res.redirect("/app/login");
        const projectId = String(req.params.projectId);
        const alertId = String(req.params.alertId);
        const membership = await prisma.membership.findUnique({
          where: {
            projectId_userId: { projectId, userId: user.id },
          },
        });
        if (!membership || membership.role === "Viewer") {
          return res.redirect("/app/projects");
        }
        const alert = await prisma.alert.findFirst({
          where: { id: alertId, projectId },
          include: { acknowledgement: true },
        });
        if (alert && !alert.acknowledgement) {
          await prisma.acknowledgement.create({
            data: { alertId, actorUserId: user.id },
          });
        }
        res.redirect(`/app/projects/${projectId}/alerts`);
      } catch (err) {
        next(err);
      }
    },
  );

  r.post(
    "/app/projects/:projectId/alerts/:alertId/retry",
    async (req, res, next) => {
      try {
        const user = await requireUiUser(req);
        if (!user) return res.redirect("/app/login");
        const projectId = String(req.params.projectId);
        const alertId = String(req.params.alertId);
        const membership = await prisma.membership.findUnique({
          where: {
            projectId_userId: { projectId, userId: user.id },
          },
        });
        if (!membership || membership.role === "Viewer") {
          return res.redirect("/app/projects");
        }
        const now = systemClock.now();
        await prisma.$executeRaw`
          UPDATE outbox_messages
             SET attempts = 0,
                 next_attempt_at = ${now},
                 lease_until = NULL,
                 last_error = NULL
           WHERE alert_id = ${alertId}::uuid
             AND delivered_at IS NULL`;
        res.redirect(`/app/projects/${projectId}/alerts`);
      } catch (err) {
        next(err);
      }
    },
  );

  r.get("/app/projects/:projectId/plan", async (req, res, next) => {
    try {
      const user = await requireUiUser(req);
      if (!user) return res.redirect("/app/login");
      const projectId = String(req.params.projectId);
      const membership = await prisma.membership.findUnique({
        where: {
          projectId_userId: { projectId, userId: user.id },
        },
      });
      if (!membership) return res.redirect("/app/projects");
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        include: { plan: true },
      });
      const plans = await prisma.plan.findMany({
        orderBy: { priceCents: "asc" },
      });
      renderPage(res, "app/plan", {
        title: "Plan",
        user: { email: user.email },
        project: { id: project.id, name: project.name },
        current: {
          name: project.plan.name,
          maxServices: project.plan.maxServices,
          maxMembers: project.plan.maxMembers,
          priceCents: project.plan.priceCents,
        },
        plans: plans.map((p) => ({
          name: p.name,
          maxServices: p.maxServices,
          priceCents: p.priceCents,
        })),
        defaultKey: `ui-${randomBytes(8).toString("hex")}`,
        brandHref: "/app",
        nav: appNav("projects"),
        error:
          membership.role !== "Owner"
            ? "Only owners can change the plan"
            : PLAN_ERRORS[String(req.query.error ?? "")],
        success: req.query.success === "1" ? "Plan updated" : undefined,
      });
    } catch (err) {
      next(err);
    }
  });

  r.post("/app/projects/:projectId/plan", async (req, res, next) => {
    try {
      const user = await requireUiUser(req);
      if (!user) return res.redirect("/app/login");
      const projectId = String(req.params.projectId);
      const membership = await prisma.membership.findUnique({
        where: {
          projectId_userId: { projectId, userId: user.id },
        },
      });
      if (!membership || membership.role !== "Owner") {
        return res.redirect(`/app/projects/${projectId}/plan`);
      }
      const body = parseBody(req);
      const planName = String(body.planName ?? "pro");
      const key = String(body.idempotencyKey ?? randomBytes(8).toString("hex"));
      const outcome = await upgradePlan(prisma, {
        projectId,
        actorUserId: user.id,
        planName,
        key,
        failPayments:
          process.env.PAYMENT_FAIL_ALL === "1" ||
          process.env.PAYMENT_FAIL_ALL === "true",
      });
      const code =
        outcome.kind === "ok" ? "success=1" : `error=${outcome.kind}`;
      return res.redirect(`/app/projects/${projectId}/plan?${code}`);
    } catch (err) {
      next(err);
    }
  });

  r.get("/", (_req, res) => {
    res.redirect("/app/login");
  });

  return r;
}
