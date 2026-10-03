import {
  RetrievalContext,
  defaultOps,
  pagePath,
  type AppMetadata,
  type RetrievalHit,
  type RetrievalKind,
} from "@cab/contracts";

export interface MetadataDocument {
  kind: RetrievalKind;
  id: string;
  pageId?: string;
  widgetId?: string;
  name: string;
  path: string;
  description: string;
  doc: string;
}

const compact = (values: Array<string | undefined>): string =>
  values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)).join(". ");

const DATE_FILTER_VOCABULARY =
  "date dates calendar day night stay overnight check-in check-out today tomorrow tonight yesterday this week this month last month";
const NUMERIC_FILTER_VOCABULARY =
  "number numeric value amount price cost rate cheaper affordable expensive under below above over less than greater than at most at least between";

function filterDocumentId(app: AppMetadata, pageId: string, filterId: string): string {
  const matches = app.pages.flatMap((page) => page.filters.filter((filter) => filter.id === filterId));
  return matches.length > 1 ? `${pageId}.${filterId}` : filterId;
}

export function buildMetadataDocuments(app: AppMetadata): MetadataDocument[] {
  const docs: MetadataDocument[] = [];

  for (const page of app.pages) {
    const path = pagePath(app, page.id);
    docs.push({
      kind: "page",
      id: page.id,
      pageId: page.id,
      name: page.name,
      path,
      description: page.description,
      doc: compact([page.name, page.id, page.description, path]),
    });

    for (const widget of page.widgets) {
      const dataset = app.datasets.find((item) => item.name === widget.dataset);
      const datasetText = dataset ? `${dataset.label} ${dataset.description}` : widget.dataset;
      docs.push({
        kind: "widget",
        id: widget.id,
        pageId: page.id,
        widgetId: widget.id,
        name: widget.name,
        path: `${path} > ${widget.name}`,
        description: widget.description,
        doc: compact([
          widget.name,
          widget.id,
          widget.type,
          widget.description,
          datasetText,
          widget.columns.map((column) => column.label ?? column.field).join(" "),
          path,
        ]),
      });
    }

    for (const filter of page.filters) {
      const optionsText = (filter.options ?? [])
        .flatMap((option) => [option.label, option.value, ...option.synonyms])
        .join(" ");
      const dataset = app.datasets.find((item) => item.fields.some((field) => field.name === filter.field));
      const field = dataset?.fields.find((item) => item.name === filter.field);
      docs.push({
        kind: "filter",
        id: filterDocumentId(app, page.id, filter.id),
        pageId: page.id,
        name: filter.label,
        path: `${path} > ${filter.label}`,
        description: filter.description,
        doc: compact([
          filter.label,
          filter.id,
          filter.field,
          filter.description,
          ...filter.synonyms,
          optionsText,
          field?.label,
          field?.description,
          ...(field?.synonyms ?? []),
          filter.type === "date" || filter.type === "dateRange" ? DATE_FILTER_VOCABULARY : undefined,
          filter.type === "number" ? NUMERIC_FILTER_VOCABULARY : undefined,
          path,
        ]),
      });
    }
  }

  for (const dataset of app.datasets) {
    const datasetPaths = app.pages
      .filter((page) => page.widgets.some((widget) => widget.dataset === dataset.name))
      .map((page) => `${pagePath(app, page.id)} > ${dataset.label}`);
    const datasetPath = datasetPaths.join(" | ") || `${app.name} > ${dataset.label}`;
    docs.push({
      kind: "dataset",
      id: dataset.name,
      name: dataset.label,
      path: datasetPath,
      description: dataset.description,
      doc: compact([
        dataset.name,
        dataset.label,
        dataset.description,
        datasetPath,
        ...dataset.fields.flatMap((field) => [
          field.name,
          field.label,
          field.description,
          ...field.synonyms,
          ...(field.enumValues ?? []),
        ]),
      ]),
    });

    for (const field of dataset.fields) {
      const fieldPaths = app.pages
        .filter((page) => page.widgets.some((widget) => widget.dataset === dataset.name))
        .map((page) => `${pagePath(app, page.id)} > ${dataset.label} > ${field.label}`);
      const fieldPath = fieldPaths.join(" | ") || `${app.name} > ${dataset.label} > ${field.label}`;
      docs.push({
        kind: "field",
        id: `${dataset.name}.${field.name}`,
        name: field.label,
        path: fieldPath,
        description: field.description,
        doc: compact([
          fieldPath,
          dataset.label,
          dataset.description,
          field.name,
          field.label,
          field.description,
          ...field.synonyms,
          ...(field.enumValues ?? []),
        ]),
      });
    }
  }

  for (const action of app.actions) {
    const path = action.pageId ? pagePath(app, action.pageId) : app.name;
    docs.push({
      kind: "action",
      id: action.id,
      pageId: action.pageId,
      name: action.label,
      path,
      description: action.description,
      doc: compact([action.label, action.id, action.description, path]),
    });
  }

  return docs;
}

export function metadataNodeId(kind: RetrievalKind, id: string): string {
  return `${kind}:${id}`;
}

export function buildMetadataContext(app: AppMetadata, hits: RetrievalHit[], currentPageId?: string): RetrievalContext {
  const pageIds = new Set<string>();
  const datasetNames = new Set<string>();

  for (const hit of hits) {
    if (hit.pageId) pageIds.add(hit.pageId);
    if (hit.kind === "page") pageIds.add(hit.id);
    if (hit.kind === "dataset") datasetNames.add(hit.id);
    if (hit.kind === "field") datasetNames.add(hit.id.split(".")[0]!);
    if (hit.kind === "dataset" || hit.kind === "field") {
      const datasetName = hit.kind === "dataset" ? hit.id : hit.id.split(".")[0];
      for (const page of app.pages) {
        if (page.widgets.some((widget) => widget.dataset === datasetName)) pageIds.add(page.id);
      }
    }
    if (hit.kind === "widget") {
      const page = app.pages.find((candidate) => candidate.widgets.some((widget) => widget.id === hit.id));
      if (page) pageIds.add(page.id);
    }
    if (hit.kind === "filter") {
      const page = app.pages.find((candidate) => candidate.filters.some((filter) => filter.id === hit.id));
      if (page) pageIds.add(page.id);
    }
    if (hit.kind === "action") {
      const action = app.actions.find((candidate) => candidate.id === hit.id);
      if (action?.pageId) pageIds.add(action.pageId);
    }
  }
  if (currentPageId && app.pages.some((page) => page.id === currentPageId)) pageIds.add(currentPageId);

  const pages = app.pages.filter((page) => pageIds.has(page.id));
  for (const page of pages) for (const widget of page.widgets) datasetNames.add(widget.dataset);

  return RetrievalContext.parse({
    appId: app.appId,
    appName: app.name,
    navTree: app.pages.map((page) => ({ id: page.id, name: page.name, route: page.route, parent: page.parent })),
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      route: page.route,
      path: pagePath(app, page.id),
      description: page.description,
      widgets: page.widgets.map((widget) => ({
        id: widget.id,
        name: widget.name,
        type: widget.type,
        dataset: widget.dataset,
        description: widget.description,
        columns: widget.columns.map((column) => ({ field: column.field, label: column.label ?? column.field })),
        sortable: widget.sortable,
      })),
      filters: page.filters.map((filter) => ({
        id: filter.id,
        label: filter.label,
        type: filter.type,
        field: filter.field,
        description: filter.description,
        operators: filter.operators ?? defaultOps(filter.type),
        options: filter.options?.map((option) => ({ value: option.value, label: option.label })),
      })),
    })),
    datasets: app.datasets.filter((dataset) => datasetNames.has(dataset.name)).map((dataset) => ({
      name: dataset.name,
      description: dataset.description,
      timeField: dataset.timeField,
      fields: dataset.fields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        description: field.description,
        derived: field.derived !== undefined,
        enumValues: field.enumValues,
        roles: field.roles,
      })),
      relations: dataset.relations,
    })),
    actions: app.actions.filter((action) => !action.pageId || pageIds.has(action.pageId)).map((action) => ({
      id: action.id,
      label: action.label,
      destructive: action.destructive,
      description: action.description,
    })),
  });
}
