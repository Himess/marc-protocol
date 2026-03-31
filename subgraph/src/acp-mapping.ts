import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  JobCreated,
  JobFunded,
  JobSubmitted,
  JobCompleted,
  PaymentReleased,
  JobRejected,
  Refunded,
} from "../generated/ConfidentialACP/ConfidentialACP";
import {
  ConfidentialJob,
  ConfidentialJobEvent,
  ACPStats,
} from "../generated/schema";

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

const ACP_STATS_ID = "acp-stats";

function eventId(event: ethereum.Event): Bytes {
  return event.transaction.hash.concatI32(event.logIndex.toI32());
}

function getOrCreateStats(): ACPStats {
  let stats = ACPStats.load(ACP_STATS_ID);
  if (stats == null) {
    stats = new ACPStats(ACP_STATS_ID);
    stats.totalJobs = BigInt.zero();
    stats.totalFunded = BigInt.zero();
    stats.totalCompleted = BigInt.zero();
    stats.totalRejected = BigInt.zero();
    stats.totalRefunded = BigInt.zero();
  }
  return stats;
}

function createJobEvent(
  event: ethereum.Event,
  jobId: string,
  type: string,
  actor: Bytes,
  data: Bytes | null,
): ConfidentialJobEvent {
  const jobEvent = new ConfidentialJobEvent(eventId(event));
  jobEvent.job = jobId;
  jobEvent.type = type;
  jobEvent.actor = actor;
  jobEvent.data = data;
  jobEvent.blockNumber = event.block.number;
  jobEvent.timestamp = event.block.timestamp;
  jobEvent.txHash = event.transaction.hash;
  jobEvent.save();
  return jobEvent;
}

// ═══════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════

export function handleJobCreated(event: JobCreated): void {
  const jobId = event.params.jobId.toString();

  const job = new ConfidentialJob(jobId);
  job.jobId = event.params.jobId;
  job.client = event.params.client;
  job.provider = event.params.provider;
  job.evaluator = event.params.evaluator;
  job.expiredAt = event.params.expiredAt;
  job.status = "created";
  job.deliverable = null;
  job.completionReason = null;
  job.rejectionReason = null;
  job.createdAt = event.block.timestamp;
  job.createdTxHash = event.transaction.hash;
  job.fundedAt = null;
  job.submittedAt = null;
  job.completedAt = null;
  job.rejectedAt = null;
  job.refundedAt = null;
  job.save();

  createJobEvent(event, jobId, "created", event.params.client, null);

  const stats = getOrCreateStats();
  stats.totalJobs = stats.totalJobs.plus(BigInt.fromI32(1));
  stats.save();
}

export function handleJobFunded(event: JobFunded): void {
  const jobId = event.params.jobId.toString();

  const job = ConfidentialJob.load(jobId);
  if (job != null) {
    job.status = "funded";
    job.fundedAt = event.block.timestamp;
    job.save();
  }

  createJobEvent(event, jobId, "funded", event.params.client, null);

  const stats = getOrCreateStats();
  stats.totalFunded = stats.totalFunded.plus(BigInt.fromI32(1));
  stats.save();
}

export function handleJobSubmitted(event: JobSubmitted): void {
  const jobId = event.params.jobId.toString();

  const job = ConfidentialJob.load(jobId);
  if (job != null) {
    job.status = "submitted";
    job.deliverable = event.params.deliverable;
    job.submittedAt = event.block.timestamp;
    job.save();
  }

  createJobEvent(
    event,
    jobId,
    "submitted",
    event.params.provider,
    event.params.deliverable,
  );
}

export function handleJobCompleted(event: JobCompleted): void {
  const jobId = event.params.jobId.toString();

  const job = ConfidentialJob.load(jobId);
  if (job != null) {
    job.status = "completed";
    job.completionReason = event.params.reason;
    job.completedAt = event.block.timestamp;
    job.save();
  }

  createJobEvent(
    event,
    jobId,
    "completed",
    event.params.evaluator,
    event.params.reason,
  );

  const stats = getOrCreateStats();
  stats.totalCompleted = stats.totalCompleted.plus(BigInt.fromI32(1));
  stats.save();
}

export function handlePaymentReleased(event: PaymentReleased): void {
  const jobId = event.params.jobId.toString();

  // No status change — job is already "completed" from handleJobCompleted
  // This event confirms the encrypted payment transfer happened
  createJobEvent(event, jobId, "payment_released", event.params.provider, null);
}

export function handleJobRejected(event: JobRejected): void {
  const jobId = event.params.jobId.toString();

  const job = ConfidentialJob.load(jobId);
  if (job != null) {
    job.status = "rejected";
    job.rejectionReason = event.params.reason;
    job.rejectedAt = event.block.timestamp;
    job.save();
  }

  createJobEvent(
    event,
    jobId,
    "rejected",
    event.params.rejector,
    event.params.reason,
  );

  const stats = getOrCreateStats();
  stats.totalRejected = stats.totalRejected.plus(BigInt.fromI32(1));
  stats.save();
}

export function handleRefunded(event: Refunded): void {
  const jobId = event.params.jobId.toString();

  const job = ConfidentialJob.load(jobId);
  if (job != null) {
    // Only update to "refunded" if not already rejected
    // (reject handler emits both JobRejected and Refunded)
    if (job.status != "rejected") {
      job.status = "refunded";
    }
    job.refundedAt = event.block.timestamp;
    job.save();
  }

  createJobEvent(event, jobId, "refunded", event.params.client, null);

  const stats = getOrCreateStats();
  stats.totalRefunded = stats.totalRefunded.plus(BigInt.fromI32(1));
  stats.save();
}
