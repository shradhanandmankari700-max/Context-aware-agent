import type { DataService, RequestContext, QuerySpec, UiState, AppMetadata } from "@cab/contracts";
import hospital from "../../../metadata/hospital.json" with { type: "json" };
import hotel from "../../../metadata/hotel.json" with { type: "json" };
import { hospitalData } from "../../../data/seed/hospital";
import { hotelData } from "../../../data/seed/hotel";
import { executeMemory, parseSpec } from "./engine";
import { defaultOps } from "@cab/contracts";

const apps=[hospital as AppMetadata,hotel as AppMetadata];
const rows:Record<string,Record<string,Record<string,unknown>[]>>={hospital:hospitalData,hotel:hotelData};
export function createFakeDataService(): DataService {
 return {
  async query(ctx,spec){const app=apps.find(a=>a.appId===ctx.appId);if(!app)throw new Error(`Unknown app ${ctx.appId}`);return executeMemory(ctx,app,parseSpec(spec),rows[ctx.appId]!);},
  async widgetData(ctx,pageId,widgetId,ui,opts){if(ui.appId!==ctx.appId)throw new Error("UI app mismatch");const app=apps.find(a=>a.appId===ctx.appId);if(!app)throw new Error(`Unknown app ${ctx.appId}`);const page=app.pages.find(p=>p.id===pageId);const widget=page?.widgets.find(w=>w.id===widgetId);if(!page||!widget)throw new Error("Unknown page or widget");const ds=app.datasets.find(d=>d.name===widget.dataset)!;const where:QuerySpec["where"]=[];
   const applicable=widget.filters?page.filters.filter(f=>widget.filters!.includes(f.id)):page.filters;
   for(const [id,value] of Object.entries(ui.filters)){const f=applicable.find(x=>x.id===id);if(!f||!ds.fields.some(x=>x.name===f.field))continue;const allowed:readonly string[]=f.operators??defaultOps(f.type);if(!allowed.includes(value.op))throw new Error(`Unsupported operator ${value.op} for filter ${id}`);const option=f.options?.find(o=>o.value===String(value.value));if(option?.where)where.push(...option.where);else where.push({field:f.field,op:value.op,value:value.value});}
   for(const f of applicable)if(!ui.filters[f.id]&&f.defaultValue&&ds.fields.some(x=>x.name===f.field))where.push({field:f.field,op:f.defaultValue.op,value:f.defaultValue.value});
   const select=widget.columns.length?widget.columns.map(c=>c.field):undefined;return executeMemory(ctx,app,parseSpec({dataset:widget.dataset,select,where,orderBy:ui.sort?.widgetId===widgetId?[{field:ui.sort.field,direction:ui.sort.direction}]:widget.defaultSort?[widget.defaultSort]:[],limit:opts?.limit??500}),rows[ctx.appId]!);
  }
 };
}
