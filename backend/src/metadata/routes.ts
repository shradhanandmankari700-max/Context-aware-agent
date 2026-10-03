import { Router, type Request, type Response } from "express";
import { ImportBundle, RetrievalKind, type MetadataStore, type RequestContext } from "@cab/contracts";
import { z } from "zod";
import { MetadataImportValidationError, MetadataStoreError } from "./store";

export interface MetadataRouterOptions {
  metadata: MetadataStore;
  resolveTenantId(request: Request): string | Promise<string>;
  resolveContext(request: Request, appId: string): RequestContext | Promise<RequestContext>;
}

export class MetadataAuthenticationError extends Error {
  constructor(message = "Authentication is required to access application metadata") {
    super(message);
    this.name = "MetadataAuthenticationError";
  }
}

const SearchRequest = z.object({
  query: z.string().min(1).max(2000),
  k: z.number().int().min(1).max(20).optional(),
  kinds: z.array(RetrievalKind).optional(),
  currentPageId: z.string().optional(),
});

function respondWithError(res: Response, error: unknown): void {
  if (error instanceof MetadataAuthenticationError) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: error.message } });
    return;
  }
  if (error instanceof MetadataImportValidationError) {
    res.status(400).json({ error: { code: error.code, message: error.message, errors: error.errors } });
    return;
  }
  if (error instanceof MetadataStoreError) {
    const status = error.code === "TENANT_MISMATCH" ? 403 : error.code === "APP_NOT_FOUND" ? 404 : 400;
    res.status(status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  console.error("[MetadataRouter] Request failed:", error);
  res.status(500).json({ error: { code: "INTERNAL", message: "Metadata request failed" } });
}

export function createMetadataRouter({ metadata, resolveTenantId, resolveContext }: MetadataRouterOptions): Router {
  const router = Router();

  router.get("/", async (request, response) => {
    try {
      response.json(await metadata.listApps(await resolveTenantId(request)));
    } catch (error) {
      respondWithError(response, error);
    }
  });

  router.get("/:appId/metadata", async (request, response) => {
    try {
      const ctx = await resolveContext(request, request.params.appId);
      response.json(await metadata.getApp(ctx));
    } catch (error) {
      respondWithError(response, error);
    }
  });

  router.post("/import", async (request, response) => {
    const parsed = ImportBundle.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: "INVALID_METADATA",
          message: "Invalid import bundle",
          errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        },
      });
      return;
    }

    try {
      const ctx = await resolveContext(request, parsed.data.metadata.appId);
      if (ctx.role !== "admin") {
        response.status(403).json({ error: { code: "FORBIDDEN", message: "Only admins can import applications" } });
        return;
      }
      response.status(201).json(await metadata.importApp(ctx.tenantId, parsed.data));
    } catch (error) {
      respondWithError(response, error);
    }
  });

  router.post("/:appId/search", async (request, response) => {
    const parsed = SearchRequest.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: "INVALID_QUERY",
          message: "Invalid metadata search request",
          details: parsed.error.format(),
        },
      });
      return;
    }
    try {
      const ctx = await resolveContext(request, request.params.appId);
      response.json(await metadata.search(ctx, parsed.data.query, {
        k: parsed.data.k,
        kinds: parsed.data.kinds,
        currentPageId: parsed.data.currentPageId,
      }));
    } catch (error) {
      respondWithError(response, error);
    }
  });

  return router;
}
