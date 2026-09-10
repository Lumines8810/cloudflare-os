import type {
  AiRequestFailureKind,
  AiRequestOutcome,
  AiRequestReservationResult,
} from "@gadgets/workshop-shared/limits";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { LIMIT_ERROR_MESSAGES } from "@gadgets/workshop-shared/limits";
import { isCloudflareLimitsEnabled } from "../config.js";
import type { UserDurableObject } from "../../user.js";

/** The two RPC methods required to meter one platform-funded AI request. */
export interface AiRequestReservationClient {
  /** Reserve a caller-supplied idempotency key before a provider request. */
  reserveAiRequest(reservationId: string): Promise<AiRequestReservationResult>;
  /** Settle a reservation without releasing its quota slot. */
  settleAiRequest(reservationId: string, outcome: AiRequestOutcome): Promise<void>;
}

/** A reservation lease held by a ModelHandle until its provider request finishes. */
export interface AiRequestLease {
  /** The idempotency key used for reserve and settle. */
  reservationId: string;
  /** Calls remaining after the reservation, when the server returned a finite window. */
  remaining?: number;
  /** Reset time returned by the server, when a finite window applies. */
  resetAt?: string;
}

/** Central pre-execution budget guard used by every platform-funded model call. */
export interface AiRequestGuard {
  /** Reserve quota before the provider is contacted. */
  reserve(): Promise<AiRequestLease>;
  /** Persist the provider outcome; failures are intentionally conservative. */
  settle(reservationId: string, outcome: AiRequestOutcome): Promise<void>;
}

/** A typed failure raised before a provider request can safely proceed. */
export class AiRequestGuardError extends Error {
  /** Stable failure classification for user messaging and retry policy. */
  readonly kind: AiRequestFailureKind;

  constructor(kind: AiRequestFailureKind, message: string) {
    super(message);
    this.name = "AiRequestGuardError";
    this.kind = kind;
  }
}

/**
 * Build a retry-safe guard over any reservation RPC client. The reserve retry reuses the same key,
 * so a response lost after a successful Durable Object write cannot double-consume the quota.
 */
export function createAiRequestGuard(client: AiRequestReservationClient): AiRequestGuard {
  return {
    async reserve(): Promise<AiRequestLease> {
      let reservationId = crypto.randomUUID();
      let result: AiRequestReservationResult;
      try {
        result = await client.reserveAiRequest(reservationId);
      } catch {
        try {
          result = await client.reserveAiRequest(reservationId);
        } catch {
          throw new AiRequestGuardError(
              "result-unknown",
              "Could not confirm the AI usage reservation. The model provider was not contacted; retry later.");
        }
      }

      if (!result.allowed) {
        throw new AiRequestGuardError(
            "budget-denied",
            result.reason ?? LIMIT_ERROR_MESSAGES.USAGE_LIMIT_EXCEEDED);
      }
      if (result.reservationId !== reservationId) {
        throw new AiRequestGuardError(
            "result-unknown",
            "The AI usage reservation response was invalid. The model provider was not contacted.");
      }
      return {
        reservationId,
        remaining: result.remaining,
        resetAt: result.resetAt,
      };
    },

    async settle(reservationId: string, outcome: AiRequestOutcome): Promise<void> {
      try {
        await client.settleAiRequest(reservationId, outcome);
      } catch {
        // A failed settlement must not turn a completed provider response into a retry. The quota
        // was consumed at reserve time, and the retained reservation row remains conservative.
        try {
          await client.settleAiRequest(reservationId, outcome);
        } catch {
          // Keep the provider result visible; the next idempotent accounting retry can reconcile it.
        }
      }
    },
  };
}

/** Create a guard for a user's platform-funded request when the optional limits flow is enabled. */
export function createUserAiRequestGuard(
    env: Cloudflare.Env, userStub: DurableObjectStub<UserDurableObject>): AiRequestGuard | undefined {
  return isCloudflareLimitsEnabled(env) ? createAiRequestGuard(userStub) : undefined;
}

/** Create a guard for a gatekeeper session scoped through its overseer's ApprovalQueue. */
export function createApprovalQueueAiRequestGuard(
    env: Cloudflare.Env, approvalQueue: Pick<ApprovalQueue, "reserveAiRequest" | "settleAiRequest">)
    : AiRequestGuard | undefined {
  return isCloudflareLimitsEnabled(env) ? createAiRequestGuard(approvalQueue) : undefined;
}
