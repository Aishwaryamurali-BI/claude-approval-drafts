/**
 * In-memory store implementations for examples and tests. In a real app these
 * are three small tables (approved drafts, usage, plan limits); the interfaces
 * in types.ts are all the drafter depends on.
 */
import type { AllowanceStore, ApprovedDraft, DraftStore, UsageRecord, UsageStore } from "./types.js";

export function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7); // "YYYY-MM" in UTC
}

export class InMemoryDraftStore implements DraftStore {
  readonly saved: ApprovedDraft[] = [];
  async save(draft: ApprovedDraft): Promise<void> {
    this.saved.push(structuredClone(draft));
  }
}

export class InMemoryUsageStore implements UsageStore {
  readonly records: UsageRecord[] = [];
  async record(entry: UsageRecord): Promise<void> {
    this.records.push(structuredClone(entry));
  }
  async spentUsd(tenantId: string, month: string): Promise<number> {
    return this.records
      .filter((r) => r.tenantId === tenantId && monthKey(r.at) === month)
      .reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  }
}

export class InMemoryAllowanceStore implements AllowanceStore {
  constructor(
    private readonly limits: Record<string, number>,
    private readonly defaultLimitUsd = 0,
  ) {}
  async monthlyLimitUsd(tenantId: string): Promise<number> {
    return this.limits[tenantId] ?? this.defaultLimitUsd;
  }
}
