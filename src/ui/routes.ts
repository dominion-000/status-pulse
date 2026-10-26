import { randomBytes } from "node:crypto";
import { Router } from "express";
import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import {
  isIncidentPublic,
  isUpdatePublic,
  type IncidentStatus,
} from "../core/incident";
import { exposeVerificationToken } from "../core/tokens";
import { createProjectSchema } from "../core/project-input";
import { createServiceSchema } from "../core/service-config";
import { createProject } from "../db/projects";
import { createService } from "../db/service-create";
import { upgradePlan } from "../db/plans";
import { acknowledgeAlert } from "../db/acknowledge-alert";
import {
  subscribeToPublicProject,
  verifySubscription,
} from "../db/subscribe";
import { registerUser } from "../db/register-user";
import {
  authRateLimitStore,
  rateLimit,
  subscribeRateLimitStore,
} from "../middleware/rate-limit";
import { systemClock } from "../core/clock";
import { verifyPassword } from "../core/password";
import { signAccessToken } from "../auth/tokens";
import { clearTokenCookie, readUserId, setTokenCookie } from "./auth-cookie";
import { renderPage } from "./render";

function appNav(active: string) {
  return [
    { href: "/app/projects", label: "Projects", active: active === "projects" },
    { href: "/app/logout", label: "Sign out", active: false },
  ];
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "project";
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
// Login and register share the API's login limit, subscribe shares the API's subscribe limit: the browser forms reach
// the same accounts and the same endpoint, and flooding one form must not lock people out of the other.
const uiAuthLimit = rateLimit({ name: "auth", store: authRateLimitStore });
const uiSubscribeLimit = rateLimit({
  name: "subscribe",
  store: subscribeRateLimitStore,
});

// Fixed messages for the redirect codes, so a crafted link cannot put its own text on the page.
const PLAN_ERRORS: Record<string, string> = {
  payment_failed: "The payment failed. The plan is unchanged.",
  key_conflict: "That Idempotency-Key was already used for a different plan.",
  unknown_plan: "Unknown plan.",
  over_limit:
    "The project has more services or members than that plan allows. Remove some first.",
};

// Fixed messages for the service form's redirect codes.
const SERVICE_ERRORS: Record<string, string> = {
  required: "Name and address are required.",
  limit:
    "This plan's service limit is reached. Upgrade the plan to add more services.",
  url: "The address is not allowed. Use a public http or https address; localhost and private networks are refused.",
  interval:
    "The interval must be one of 30, 60, 120, 300, 600, 900, 1800 or 3600 seconds.",
  timeout: "The timeout must be shorter than the interval.",
  invalid: "The configuration is not valid.",
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

  r.post("/status/:slug/subscribe", uiSubscribeLimit, async (req, res, next) => {
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

      const result = await subscribeToPublicProject(prisma, {
        projectSlug: slug,
        email,
        serviceIds: ids,
      });

      if (!result.ok) {
        const services = await prisma.service.findMany({
          where: {
            projectId: project.id,
            isPublic: true,
            enabled: true,
            deletedAt: null,
          },
          select: { id: true, name: true },
        });
        const message =
          result.reason === "no_public_services"
            ? "Select at least one public service"
            : "One or more services are not public or not found";
        return renderPage(res, "public/subscribe", {
          title: "Subscribe",
          error: message,
          project,
          services,
          brandHref: `/status/${slug}`,
          nav: publicNav(slug),
        }, 400);
      }

      if (result.alreadyVerified) {
        return renderPage(res, "public/subscribe", {
          title: "Subscribe",
          project,
          services: [],
          done: true,
          brandHref: `/status/${slug}`,
          nav: publicNav(slug),
        });
      }

      renderPage(res, "public/subscribe", {
        title: "Subscribe",
        project,
        services: result.serviceNames.map((name, i) => ({
          id: ids[i] ?? "",
          name,
        })),
        done: true,
        verificationToken: exposeVerificationToken()
          ? result.verificationToken
          : undefined,
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
      const body = parseBody(req);
      const token = String(body.token ?? "").trim();
      if (!token) {
        return renderPage(res, "public/verify", {
          title: "Verify subscription",
          error: "Token is required",
          brandHref: "/",
          nav: [],
        }, 400);
      }
      const result = await verifySubscription(prisma, { token });
      if (!result.ok) {
        return renderPage(res, "public/verify", {
          title: "Verify subscription",
          error: "This verification link is invalid or has already been used",
          brandHref: "/",
          nav: [],
        }, 410);
      }
      renderPage(res, "public/verify", {
        title: "Verify subscription",
        done: true,
        email: result.subscriber.email,
        brandHref: "/",
        nav: [],
      });
    } catch (err) {
      next(err);
    }
  });

  r.get("/app/login", (req, res) => {
    if (readUserId(req, config)) return res.redirect("/app/projects");
    renderPage(res, "auth/login", {
      title: "Sign in",
      brandHref: "/app/login",
      nav: [{ href: "/app/register", label: "Register", active: false }],
    });
  });

  r.post("/app/login", uiAuthLimit, async (req, res, next) => {
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
      res.redirect("/app/projects");
    } catch (err) {
      next(err);
    }
  });

  r.get("/app/register", (req, res) => {
    if (readUserId(req, config)) return res.redirect("/app/projects");
    renderPage(res, "auth/register", {
      title: "Register",
      brandHref: "/app/register",
      nav: [{ href: "/app/login", label: "Sign in", active: false }],
    });
  });

  r.post("/app/register", uiAuthLimit, async (req, res, next) => {
    try {
      const body = parseBody(req);
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const created = await registerUser(prisma, {
        email,
        password,
        strictPassword: false,
      });
      if (!created.ok) {
        const status = created.reason === "email_taken" ? 409 : 400;
        const error =
          created.reason === "email_taken"
            ? "Email already registered"
            : (created.passwordMessages?.[0] ?? "Invalid password");
        return renderPage(res, "auth/register", {
          title: "Register",
          error,
          brandHref: "/app/register",
          nav: [{ href: "/app/login", label: "Sign in", active: false }],
        }, status);
      }
      const token = signAccessToken(
        created.user.id,
        config.jwtSecret,
        config.accessTokenTtlSeconds,
      );
      setTokenCookie(res, token, config.accessTokenTtlSeconds);
      res.redirect("/app/projects");
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
    res.redirect("/app/projects");
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
      res.redirect("/app/projects");
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

  
  r.post("/app/projects", async (req, res, next) => {
    try {
      const user = await requireUiUser(req);
      if (!user) return res.redirect("/app/login");
      const body = parseBody(req);
      const name = String(body.name ?? "").trim();
      let slug = String(body.slug ?? "").trim().toLowerCase();
      if (!slug && name) slug = slugify(name);
      const memberships = await prisma.membership.findMany({
        where: { userId: user.id },
        include: { project: true },
        orderBy: { createdAt: "desc" },
      });
      const projects = memberships.map((m) => ({
        id: m.project.id,
        name: m.project.name,
        slug: m.project.slug,
        role: m.role,
      }));
      if (!name || !slug) {
        return renderPage(res, "app/projects", {
          title: "Projects",
          user: { email: user.email },
          projects,
          formError: "Name and slug are required",
          formName: name,
          formSlug: slug,
          brandHref: "/app/projects",
          nav: appNav("projects"),
        }, 400);
      }
      const parsed = createProjectSchema.safeParse({ name, slug });
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        return renderPage(res, "app/projects", {
          title: "Projects",
          user: { email: user.email },
          projects,
          formError: field === "slug" ? "Slug must be 2 to 64 lowercase letters or digits, with single hyphens between them" : "Name must be 1 to 120 characters",
          formName: name,
          formSlug: slug,
          brandHref: "/app/projects",
          nav: appNav("projects"),
        }, 400);
      }
      const outcome = await createProject(prisma, {
        actorUserId: user.id,
        name,
        slug,
      });
      if (outcome.kind === "slug_taken") {
        return renderPage(res, "app/projects", {
          title: "Projects",
          user: { email: user.email },
          projects,
          formError: "That slug is already taken",
          formName: name,
          formSlug: slug,
          brandHref: "/app/projects",
          nav: appNav("projects"),
        }, 409);
      }
      if (outcome.kind === "plans_missing") {
        return renderPage(res, "app/projects", {
          title: "Projects",
          user: { email: user.email },
          projects,
          formError: "Plans are not seeded on this deployment",
          formName: name,
          formSlug: slug,
          brandHref: "/app/projects",
          nav: appNav("projects"),
        }, 500);
      }
      const project = outcome.project;
      res.redirect(`/app/projects/${project.id}`);
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
        tab: "overview",
        canManage: membership.role === "Owner",
        formError: SERVICE_ERRORS[String(req.query.error ?? "")],
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
        brandHref: "/app/projects",
        nav: appNav("projects"),
      });
    } catch (err) {
      next(err);
    }
  });

  
  r.post("/app/projects/:projectId/services", async (req, res, next) => {
    try {
      const user = await requireUiUser(req);
      if (!user) return res.redirect("/app/login");
      const projectId = String(req.params.projectId);
      const membership = await prisma.membership.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } },
      });
      if (!membership || membership.role !== "Owner") {
        return res.redirect(`/app/projects/${projectId}`);
      }
      const body = parseBody(req);
      const name = String(body.name ?? "").trim();
      const url = String(body.url ?? "").trim();
      const intervalSeconds = Number(body.intervalSeconds ?? 60);
      const timeoutSeconds = Number(body.timeoutSeconds ?? 10);
      const isPublic = body.isPublic === "true" || body.isPublic === true;

      if (!name || !url)
        return res.redirect(`/app/projects/${projectId}?error=required`);
      const parsed = createServiceSchema.safeParse({
        name,
        url,
        intervalSeconds,
        timeoutSeconds,
        isPublic,
      });
      const codeFor = (path: unknown) =>
        path === "url"
          ? "url"
          : path === "intervalSeconds"
            ? "interval"
            : path === "timeoutSeconds"
              ? "timeout"
              : "invalid";
      if (!parsed.success)
        return res.redirect(
          `/app/projects/${projectId}?error=${codeFor(parsed.error.issues[0]?.path[0])}`,
        );
      const outcome = await createService(prisma, config, {
        projectId,
        actorUserId: user.id,
        input: parsed.data,
      });
      if (outcome.kind === "plan_limit")
        return res.redirect(`/app/projects/${projectId}?error=limit`);
      if (outcome.kind === "invalid")
        return res.redirect(
          `/app/projects/${projectId}?error=${codeFor(outcome.issues[0]?.path)}`,
        );
      res.redirect(`/app/projects/${projectId}`);
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
        tab: "alerts",
        brandHref: "/app/projects",
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
        await acknowledgeAlert(prisma, {
          projectId,
          alertId,
          actorUserId: user.id,
        });
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
        tab: "plan",
        canUpgrade: membership.role === "Owner",
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
        brandHref: "/app/projects",
        nav: appNav("projects"),
        error:
          membership.role !== "Owner"
            ? "Only owners can change the plan"
            : (typeof PLAN_ERRORS !== "undefined"
                ? PLAN_ERRORS[String(req.query.error ?? "")]
                : undefined),
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
