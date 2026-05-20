import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

// Augment Express Request to carry the request id
declare module "express" {
  interface Request {
    id?: string;
  }
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.headers["x-request-id"];
    const id = Array.isArray(inbound)
      ? (inbound[0] ?? crypto.randomUUID())
      : (inbound ?? crypto.randomUUID());

    req.id = id;
    res.setHeader("x-request-id", id);
    next();
  }
}
