import type { AppMetadata, MetadataStore } from "@cab/contracts";
import { createFakeMetadataStore } from "../metadata/fake";

export function createFakeRetriever(
  app: AppMetadata,
  tenantId = "tenant-test",
): Pick<MetadataStore, "search" | "buildContext"> {
  const metadata = createFakeMetadataStore([{ tenantId, metadata: app }]);
  return {
    search: (ctx, query, options) => metadata.search(ctx, query, options),
    buildContext: (ctx, hits, currentPageId) => metadata.buildContext(ctx, hits, currentPageId),
  };
}
