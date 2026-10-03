export {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSION,
  createLocalEmbedder,
  embed,
  normalizeEmbedding,
  type LocalEmbedderOptions,
  type TextEmbedder,
} from "./embed";
export { reciprocalRankFuse, searchMetadata } from "./search";
export { createFakeRetriever } from "./fake";
export { buildMetadataContext, buildMetadataDocuments, type MetadataDocument } from "../metadata/documents";
