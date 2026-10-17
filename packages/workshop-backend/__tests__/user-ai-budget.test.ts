import { describe, expect, it } from "vitest";
import type { AiRequestOutcome } from "@gadgets/workshop-shared/limits";
import { UserDurableObject } from "../src/user.js";

type StoredReservation = {
  id: string;
  day: string;
  status: "reserved" | "settled" | "denied";
  outcome?: AiRequestOutcome;
  createdAt: number;
  settledAt?: number;
};

function makeUser(limit = 2): {
  user: UserDurableObject;
  daily: {get(): {day: string; count: number} | null; put(value: {day: string; count: number}): void};
  records: Map<string, StoredReservation>;
} {
  const records = new Map<string, StoredReservation>();
  let daily: {day: string; count: number} | null = null;
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    env: {DAILY_LLM_CALL_LIMIT: `${limit}`},
    storage: {
      aiReservations: {
        get: (id: string) => records.get(id),
        list: () => records.values(),
        put: (record: StoredReservation) => records.set(record.id, {...record}),
        delete: (id: string) => records.delete(id),
      },
      dailyLlmCount: {
        get: () => daily,
        put: (value: {day: string; count: number}) => { daily = {...value}; },
      },
    },
  });
  return {
    user,
    daily: {
      get: () => daily,
      put: value => { daily = {...value}; },
    },
    records,
  };
}

describe("UserDurableObject AI request reservations", () => {
  it("counts only allowed reservations and makes repeat reserve/settle idempotent", async () => {
    const {user, daily, records} = makeUser(2);

    await expect(user.reserveAiRequest("one")).resolves.toMatchObject({
      allowed: true, reservationId: "one", remaining: 1,
    });
    await expect(user.reserveAiRequest("one")).resolves.toMatchObject({
      allowed: true, reservationId: "one", remaining: 1,
    });
    expect(daily.get()?.count).toBe(1);

    await expect(user.reserveAiRequest("two")).resolves.toMatchObject({allowed: true, remaining: 0});
    await expect(user.reserveAiRequest("three")).resolves.toMatchObject({
      allowed: false, remaining: 0,
    });
    expect(daily.get()?.count).toBe(2);
    expect(records.get("three")?.status).toBe("denied");

    await user.settleAiRequest("one", "result-unknown");
    await expect(user.settleAiRequest("one", "result-unknown")).resolves.toBeUndefined();
    expect(records.get("one")).toMatchObject({status: "settled", outcome: "result-unknown"});
  });

  it("serializes concurrent callers at the reservation boundary", async () => {
    const {user, daily} = makeUser(2);
    const results = await Promise.all(
      Array.from({length: 8}, (_, i) => user.reserveAiRequest(`request-${i}`)));

    expect(results.filter(result => result.allowed)).toHaveLength(2);
    expect(results.filter(result => !result.allowed)).toHaveLength(6);
    expect(daily.get()?.count).toBe(2);
  });

  it("never releases a slot for a failed provider result", async () => {
    const {user, daily} = makeUser(1);
    await user.reserveAiRequest("failed");
    await user.settleAiRequest("failed", "provider");

    await expect(user.reserveAiRequest("next")).resolves.toMatchObject({allowed: false});
    expect(daily.get()?.count).toBe(1);
  });
});
