import { Router, type Request } from "express";
import type { AnalyticsService, RequestContext } from "@cab/contracts";
import type { ContextResolver } from "../data/routes";
export function createAnalyticsRouter(analytics:AnalyticsService,context:ContextResolver){const router=Router();router.post("/run",async(req:Request,res)=>{try{res.json(await analytics.run(await context(req),req.body.spec??req.body));}catch(e){res.status(400).json({error:e instanceof Error?e.message:"Invalid analysis request"});}});return router;}
