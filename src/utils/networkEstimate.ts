/**
 * Network requirements per user (NFR-154). The estimate multiplies measured response sizes by how often a user's screen
 * asks for them. Sizes are measured by scripts/measureNetwork.ts against the running application; the user counts and
 * rates are Qatar Airways' projection, which is why the figures are inputs and not constants.
 */

export type Measured = { queueListBytes: number; caseBytes: number; noteBytes: number; sessionBytes: number };
export type Projection = { concurrentNurses: number; managerBoards: number; pollSeconds: number; callsPerNurseHour: number; casesOpenedPerCall: number; requestsPerCallOther: number; headroom: number };

export const DEFAULT_PROJECTION: Projection = { concurrentNurses: 50, managerBoards: 5, pollSeconds: 15, callsPerNurseHour: 6, casesOpenedPerCall: 3, requestsPerCallOther: 40, headroom: 1.5 };

export type Estimate = { perNurseKbps: number; perBoardKbps: number; totalMbps: number; peakMbps: number; monthlyGbPerNurse: number };

export function estimate(m: Measured, p: Projection = DEFAULT_PROJECTION): Estimate {
  const pollBytesPerSecond = m.queueListBytes / p.pollSeconds;
  const callBytesPerHour = p.callsPerNurseHour * (p.casesOpenedPerCall * m.caseBytes + m.noteBytes + p.requestsPerCallOther * m.sessionBytes);
  const nurseBytesPerSecond = pollBytesPerSecond + callBytesPerHour / 3600;
  const boardBytesPerSecond = pollBytesPerSecond;
  const totalBytesPerSecond = p.concurrentNurses * nurseBytesPerSecond + p.managerBoards * boardBytesPerSecond;
  const kbps = (bytes: number) => Math.round(((bytes * 8) / 1000) * 100) / 100;
  return {
    perNurseKbps: kbps(nurseBytesPerSecond),
    perBoardKbps: kbps(boardBytesPerSecond),
    totalMbps: Math.round(((totalBytesPerSecond * 8) / 1e6) * 1000) / 1000,
    peakMbps: Math.round(((totalBytesPerSecond * p.headroom * 8) / 1e6) * 1000) / 1000,
    monthlyGbPerNurse: Math.round(((nurseBytesPerSecond * 3600 * 8 * 22) / 1e9) * 1000) / 1000
  };
}
