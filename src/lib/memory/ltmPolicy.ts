import type { LTMCategory } from "../../types/engine";

export const LTM_POLICY: Record<
  LTMCategory,
  {
    pendingToActive: number;
    ttlDays?: number;
    maxActive: number;
  }
> = {
  profile: { pendingToActive: 2, ttlDays: undefined, maxActive: 15 },
  habit: { pendingToActive: 2, ttlDays: 180, maxActive: 10 },
  task: { pendingToActive: 1, ttlDays: 90, maxActive: 15 },
  decision: { pendingToActive: 1, ttlDays: undefined, maxActive: 10 },
  learning: { pendingToActive: 1, ttlDays: undefined, maxActive: 5 },
};
