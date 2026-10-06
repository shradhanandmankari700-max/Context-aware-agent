import { Router, type Request } from "express";
import type { DataService, RequestContext } from "@cab/contracts";
export type ContextResolver=(req:Request)=>RequestContext|Promise<RequestContext>;
export function createDataRouter(data:DataService,context:ContextResolver){const router=Router();
 router.post("/query",async(req,res)=>{try{res.json(await data.query(await context(req),req.body.spec??req.body));}catch(e){res.status(400).json({error:e instanceof Error?e.message:"Invalid data query"});}});
 router.post("/widget",async(req,res)=>{try{const ctx=await context(req);const uiState=req.body.uiState ?? req.body.ui ?? {};res.json(await data.widgetData(ctx,req.body.pageId,req.body.widgetId,uiState,req.body.opts));}catch(e){res.status(400).json({error:e instanceof Error?e.message:"Invalid widget query"});}});
 return router;}
