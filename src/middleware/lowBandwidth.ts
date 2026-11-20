import type { NextFunction, Request, Response } from "express";
import type { QueueItemDto } from "../types/queue.js";

/**
 * Graceful degradation on a slow connection (NFR-122). A client that asks for less (the browser's Save-Data header,
 * an ECT hint of 2g or slower, or X-Low-Bandwidth: 1) gets lists without the bulky parts, which it can still fetch
 * one case at a time. Responses are always compressed; the full detail of a single case is never trimmed.
 */

export type LowBandwidthRequest = Request & { lowBandwidth?: boolean };

export function wantsLowBandwidth(headers: Record<string, string | string[] | undefined>): boolean {
  const one = (name: string) => String(headers[name] ?? "").toLowerCase();
  return one("save-data") === "on" || one("x-low-bandwidth") === "1" || /^(slow-2g|2g)$/.test(one("ect"));
}

export function lowBandwidthMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    (req as LowBandwidthRequest).lowBandwidth = wantsLowBandwidth(req.headers);
    res.vary("Save-Data");
    res.vary("ECT");
    if ((req as LowBandwidthRequest).lowBandwidth) res.setHeader("X-Low-Bandwidth-Applied", "1");
    next();
  };
}

/** A queue row with the heavy parts left out: enough for the list, with the case itself fetched when opened. */
export function slimQueueItem(item: QueueItemDto): Partial<QueueItemDto> & { slim: true } {
  const { transitionLogs: _t, stccProcess: _s, preparedProtocol, reasonCallCapture: _r, clinicalApproval: _c, sbarNoteText: _n, ...rest } = item;
  return {
    ...rest,
    ...(preparedProtocol ? { preparedProtocol: { ...preparedProtocol, acuityQuestionPreview: [], ragShadow: undefined, suggestions: preparedProtocol.suggestions.slice(0, 3) } } : {}),
    slim: true
  } as Partial<QueueItemDto> & { slim: true };
}
