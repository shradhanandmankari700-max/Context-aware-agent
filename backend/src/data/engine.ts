import { QuerySpec as Schema, type QuerySpec, type QueryResult, type Dataset, type AppMetadata, type RequestContext } from "@cab/contracts";
import { normalizeDateValue } from "@cab/contracts";
import { randomUUID } from "node:crypto";

export function fieldMap(ds: Dataset) { return new Map(ds.fields.map(f=>[f.name,f])); }
export function parseSpec(raw: unknown): QuerySpec { return Schema.parse(raw); }
export function resolvedWhere(ctx: RequestContext, ds: Dataset, where: QuerySpec["where"]) {
  const fields=fieldMap(ds);
  return where.map(c=>fields.get(c.field)?.type==="date" ? {...c,...normalizeDateValue(c.op,c.value,ctx.now)} : c);
}
export function derive(row: Record<string,unknown>, ds: Dataset, field: string): unknown {
  const f=fieldMap(ds).get(field); if(!f) return undefined; if(!f.derived) return row[field];
  const ev=(x: unknown): number=>{if(typeof x==="number")return x;if(typeof x==="string")return Number(row[x]??0);const e=x as {op:string;args:unknown[]};const a=e.args.map(ev);switch(e.op){case"add":return a.reduce((n,v)=>n+v,0);case"sub":return a[0]!-a[1]!;case"mul":return a.reduce((n,v)=>n*v,1);case"div":return a[1]===0?0:a[0]!/a[1]!;case"min":return Math.min(...a);case"max":return Math.max(...a);case"round":{const p=10**a[1]!;return Math.round(a[0]!*p)/p;}default:return 0;}};
  return ev(f.derived);
}
export function matches(v: unknown, op: string, val: unknown): boolean { const c=Array.isArray(val)?val:[]; switch(op){case"eq":return String(v)===String(val);case"neq":return String(v)!==String(val);case"lt":return (v as number|string)<(val as number|string);case"lte":return (v as number|string)<=(val as number|string);case"gt":return (v as number|string)>(val as number|string);case"gte":return (v as number|string)>=(val as number|string);case"in":return c.some(x=>String(x)===String(v));case"between":return c.length===2&&(v as number|string)>=(c[0] as number|string)&&(v as number|string)<=(c[1] as number|string);case"contains":return String(v??"").toLowerCase().includes(String(val).toLowerCase());default:throw new Error(`Unsupported operation: ${op}`);} }
export function executeMemory(ctx: RequestContext, metadata: AppMetadata, spec: QuerySpec, source: Record<string,Record<string,unknown>[]>, cap=500): QueryResult {
  const ds=metadata.datasets.find(x=>x.name===spec.dataset); if(!ds) throw new Error(`Unknown dataset: ${spec.dataset}`);
  if(ctx.appId!==metadata.appId) throw new Error("Cannot query another app");
  const fields=fieldMap(ds), where=resolvedWhere(ctx,ds,spec.where);
  for(const g of spec.groupBy)if(g.grain&&fields.get(g.field)?.type!=="date")throw new Error(`Time grain requires a date field: ${g.field}`);
  for(const m of spec.metrics)if(m.agg!=="count"&&fields.get(m.field)?.type!=="number")throw new Error(`${m.agg} requires a numeric field: ${m.field}`);
  const requested=[...(spec.select??[]),...spec.groupBy.map(x=>x.field),...spec.metrics.map(x=>x.field)];
  for(const f of requested) if(!fields.has(f)) throw new Error(`Unknown field: ${f}`);
  for(const c of where) if(!fields.has(c.field)) throw new Error(`Unknown field: ${c.field}`);
  const aliases=new Set(spec.metrics.map(m=>m.as??`${m.agg}_${m.field}`));
  for(const o of spec.orderBy) if(!fields.has(o.field)&&!aliases.has(o.field)) throw new Error(`Unknown order field: ${o.field}`);
  if(spec.limit>500) throw new Error("Limit cannot exceed 500");
  const all=source[ds.name]??[];
  const filtered=all.filter(row=>where.every(w=>matches(derive(row,ds,w.field),w.op,w.value)));
  const resultRows:Record<string,unknown>[]=[];
  if(spec.metrics.length||spec.groupBy.length){
    const groups=new Map<string,Record<string,unknown>[]>();
    for(const row of filtered){const key=spec.groupBy.map(g=>derive(row,ds,g.field)); const k=JSON.stringify(key);groups.set(k,[...(groups.get(k)??[]),row]);}
    for(const rows of groups.values()) {const out:Record<string,unknown>={}; spec.groupBy.forEach((g,i)=>{let v=derive(rows[0]!,ds,g.field);if(g.grain&&typeof v==="string"){const d=new Date(`${v}T00:00:00Z`);if(g.grain==="month")v=v.slice(0,7);if(g.grain==="week"){d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));v=d.toISOString().slice(0,10);}}out[g.field]=v;}); for(const m of spec.metrics){const vals=rows.map(r=>derive(r,ds,m.field)).filter(v=>v!==null&&v!==undefined).map(Number);let n:number|null=null;switch(m.agg){case"count":n=vals.length;break;case"sum":n=vals.reduce((a,b)=>a+b,0);break;case"avg":n=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null;break;case"min":n=vals.length?Math.min(...vals):null;break;case"max":n=vals.length?Math.max(...vals):null;}out[m.as??`${m.agg}_${m.field}`]=n;}resultRows.push(out);}
  } else for(const row of filtered) {const chosen=spec.select??ds.fields.map(f=>f.name);const out:Record<string,unknown>={}; for(const name of chosen)out[name]=derive(row,ds,name);resultRows.push(out);}
  for(const o of [...spec.orderBy].reverse()) resultRows.sort((a,b)=>{const x=a[o.field],y=b[o.field];const c=x==null?1:y==null?-1:typeof x==="number"&&typeof y==="number"?x-y:String(x).localeCompare(String(y));return o.direction==="asc"?c:-c;});
  const limit=Math.min(spec.limit,cap), truncated=resultRows.length>limit, rows=resultRows.slice(0,limit);
  const cols=spec.metrics.length||spec.groupBy.length?[...spec.groupBy.map(g=>g.field),...spec.metrics.map(m=>m.as??`${m.agg}_${m.field}`)]:spec.select??ds.fields.map(f=>f.name);
  return {queryId:randomUUID(),dataset:ds.name,columns:cols.map(name=>({name,label:fields.get(name)?.label??name,type:(fields.get(name)?.type??(typeof rows[0]?.[name]==="number"?"number":"string")) as "string"|"number"|"date"|"boolean"})),rows,rowCount:rows.length,truncated,appliedWhere:where,sqlPreview:`SELECT ${cols.join(", ")} FROM ${ds.table} /* parameterized */`};
}
