import { describe, expect, it, vi } from "vitest";
import {
  AiRequestGuardError,
  createAiRequestGuard,
  type AiRequestReservationClient,
} from "../src/ai-gateway-billing/limits/ai-budget.js";

describe("AI request reservation guard", () => {
  it("retries a lost reservation response with the same idempotency key", async () => {
    const client: AiRequestReservationClient = {
      reserveAiRequest: vi.fn()
        .mockRejectedValueOnce(new Error("response lost"))
        .mockImplementation(async (reservationId: string) => ({
          allowed: true,
          reservationId,
          remaining: 4,
          resetAt: "2026-09-11T00:00:00.000Z",
        })),
      settleAiRequest: vi.fn(async () => {}),
    };
    const guard = createAiRequestGuard(client);

    const lease = await guard.reserve();
    expect(client.reserveAiRequest).toHaveBeenCalledTimes(2);
    expect(client.reserveAiRequest.mock.calls[0][0]).toBe(
        client.reserveAiRequest.mock.calls[1][0]);
    expect(lease.remaining).toBe(4);

    await guard.settle(lease.reservationId, "result-unknown");
    expect(client.settleAiRequest).toHaveBeenCalledWith(
        lease.reservationId, "result-unknown");
  });

  it("does not turn a denied reservation into a provider call", async () => {
    const client: AiRequestReservationClient = {
      reserveAiRequest: vi.fn(async (reservationId: string) => ({
        allowed: false,
        reservationId,
        remaining: 0,
        reason: "limit reached",
      })),
      settleAiRequest: vi.fn(async () => {}),
    };
    const guard = createAiRequestGuard(client);

    await expect(guard.reserve()).rejects.toMatchObject({
      kind: "budget-denied",
      message: "limit reached",
    });
    expect(client.settleAiRequest).not.toHaveBeenCalled();
  });

  it("keeps accounting conservative when settlement RPCs fail", async () => {
    const client: AiRequestReservationClient = {
      reserveAiRequest: vi.fn(async (reservationId: string) => ({
        allowed: true,
        reservationId,
      })),
      settleAiRequest: vi.fn(async () => { throw new Error("accounting unavailable"); }),
    };
    const guard = createAiRequestGuard(client);

    const lease = await guard.reserve();
    await expect(guard.settle(lease.reservationId, "provider")).resolves.toBeUndefined();
    expect(client.settleAiRequest).toHaveBeenCalledTimes(2);
  });

  it("classifies a repeated/invalid reservation response as result-unknown", async () => {
    const client: AiRequestReservationClient = {
      reserveAiRequest: vi.fn(async () => ({allowed: true, reservationId: "other-id"})),
      settleAiRequest: vi.fn(async () => {}),
    };
    const guard = createAiRequestGuard(client);

    await expect(guard.reserve()).rejects.toBeInstanceOf(AiRequestGuardError);
    await expect(guard.reserve()).rejects.toMatchObject({kind: "result-unknown"});
  });
});
