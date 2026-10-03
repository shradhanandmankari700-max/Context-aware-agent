import type { AnalyticsService, DataService, MetadataStore } from "@cab/contracts";
import { createAnalyticsService } from "./index";
export function createFakeAnalyticsService({data,metadata}:{data:DataService;metadata:MetadataStore}):AnalyticsService{return createAnalyticsService({data,metadata});}
