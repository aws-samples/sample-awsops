// Gap L217: the request-estimate unit prices, exported so the estimator
// (lib/opencost-allocation.ts) and the /eks/cost Cost Calculation Basis panel share ONE
// source — the documented numbers can never drift from the computed ones.
// Fargate-style on-demand (ap-northeast-2). Spot/RI/Savings-Plans discounts NOT reflected.
export const ESTIMATE_UNIT_PRICES = {
  vcpuHour: 0.04656, // $/vCPU-hour
  gbHour: 0.00511,   // $/GB-hour (memory)
} as const;

/** Daily request-estimate parts for one pod — the estimator CALLS this (not a copy), so the
 *  panel's formula and the computed numbers are lockstep by construction. memGb uses GiB
 *  semantics (PodRow.memRequest is MiB → /1024), matching the ecs_task deriver. */
export function estimateDailyParts(vcpuRequest: number, memGb: number): { cpu: number; ram: number; total: number } {
  const cpu = vcpuRequest * ESTIMATE_UNIT_PRICES.vcpuHour * 24;
  const ram = memGb * ESTIMATE_UNIT_PRICES.gbHour * 24;
  return { cpu, ram, total: cpu + ram };
}

export function estimateDailyCost(vcpuRequest: number, memGb: number): number {
  return estimateDailyParts(vcpuRequest, memGb).total;
}
