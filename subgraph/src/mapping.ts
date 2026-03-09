import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  Deposited,
  PaymentExecuted,
  WithdrawRequested,
  WithdrawCancelled,
  WithdrawExpired,
  WithdrawFinalized,
  TreasuryUpdated,
  TreasuryWithdrawn,
  OwnershipTransferStarted,
  OwnershipTransferred,
  BalanceRequested,
  PoolCapUpdated,
  Paused,
  Unpaused,
} from "../generated/ConfidentialPaymentPool/ConfidentialPaymentPool";
import {
  User,
  Payment,
  Deposit,
  Withdrawal,
  PoolStats,
  CapUpdate,
  TreasuryAction,
} from "../generated/schema";

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

const POOL_STATS_ID = Bytes.fromUTF8("pool-stats");

/** Fee calculation matching contract: max(amount * 10 / 10000, 10000) */
function estimateFee(amount: BigInt): BigInt {
  const percentageFee = amount.times(BigInt.fromI32(10)).div(BigInt.fromI32(10000));
  const minFee = BigInt.fromI32(10000);
  return percentageFee.gt(minFee) ? percentageFee : minFee;
}

function eventId(event: ethereum.Event): Bytes {
  return event.transaction.hash.concatI32(event.logIndex.toI32());
}

function getOrCreateUser(address: Bytes, timestamp: BigInt): User {
  let user = User.load(address);
  if (user == null) {
    user = new User(address);
    user.totalDeposited = BigInt.zero();
    user.totalWithdrawn = BigInt.zero();
    user.isInitialized = false;
    user.lastActivity = timestamp;
  }
  return user;
}

function getOrCreateStats(): PoolStats {
  let stats = PoolStats.load(POOL_STATS_ID);
  if (stats == null) {
    stats = new PoolStats(POOL_STATS_ID);
    stats.totalDeposits = BigInt.zero();
    stats.totalPayments = BigInt.zero();
    stats.totalWithdrawals = BigInt.zero();
    stats.totalFees = BigInt.zero();
    stats.isPaused = false;
    stats.currentOwner = Bytes.empty();
    stats.pendingOwner = null;
    stats.treasury = Bytes.empty();
    stats.maxPoolBalance = BigInt.zero();
    stats.maxUserDeposit = BigInt.zero();
  }
  return stats;
}

// ═══════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════

export function handleDeposited(event: Deposited): void {
  const amount = BigInt.fromU64(event.params.amount.toU64());
  const fee = estimateFee(amount);

  // Create Deposit entity
  const deposit = new Deposit(eventId(event));
  deposit.user = event.params.user;
  deposit.amount = amount;
  deposit.blockNumber = event.block.number;
  deposit.timestamp = event.block.timestamp;
  deposit.txHash = event.transaction.hash;
  deposit.save();

  // Update User
  const user = getOrCreateUser(event.params.user, event.block.timestamp);
  user.totalDeposited = user.totalDeposited.plus(amount);
  user.isInitialized = true;
  user.lastActivity = event.block.timestamp;
  user.save();

  // Update PoolStats
  const stats = getOrCreateStats();
  stats.totalDeposits = stats.totalDeposits.plus(amount);
  stats.totalFees = stats.totalFees.plus(fee);
  stats.save();
}

export function handlePaymentExecuted(event: PaymentExecuted): void {
  const minPrice = BigInt.fromU64(event.params.minPrice.toU64());
  const fee = estimateFee(minPrice);

  // Create Payment entity
  const payment = new Payment(eventId(event));
  payment.from = event.params.from;
  payment.to = event.params.to;
  payment.minPrice = minPrice;
  payment.nonce = event.params.nonce;
  payment.memo = event.params.memo;
  payment.blockNumber = event.block.number;
  payment.timestamp = event.block.timestamp;
  payment.txHash = event.transaction.hash;
  payment.save();

  // Update sender
  const sender = getOrCreateUser(event.params.from, event.block.timestamp);
  sender.lastActivity = event.block.timestamp;
  sender.save();

  // Update recipient
  const recipient = getOrCreateUser(event.params.to, event.block.timestamp);
  recipient.isInitialized = true;
  recipient.lastActivity = event.block.timestamp;
  recipient.save();

  // Update PoolStats
  const stats = getOrCreateStats();
  stats.totalPayments = stats.totalPayments.plus(minPrice);
  stats.totalFees = stats.totalFees.plus(fee);
  stats.save();
}

export function handleWithdrawRequested(event: WithdrawRequested): void {
  const withdrawal = new Withdrawal(eventId(event));
  withdrawal.user = event.params.user;
  withdrawal.amount = BigInt.zero(); // encrypted, unknown until finalized
  withdrawal.type = "requested";
  withdrawal.expiresAt = event.params.expiresAt;
  withdrawal.blockNumber = event.block.number;
  withdrawal.timestamp = event.block.timestamp;
  withdrawal.txHash = event.transaction.hash;
  withdrawal.save();

  const user = getOrCreateUser(event.params.user, event.block.timestamp);
  user.lastActivity = event.block.timestamp;
  user.save();
}

export function handleWithdrawCancelled(event: WithdrawCancelled): void {
  const withdrawal = new Withdrawal(eventId(event));
  withdrawal.user = event.params.user;
  withdrawal.amount = BigInt.zero();
  withdrawal.type = "cancelled";
  withdrawal.expiresAt = null;
  withdrawal.blockNumber = event.block.number;
  withdrawal.timestamp = event.block.timestamp;
  withdrawal.txHash = event.transaction.hash;
  withdrawal.save();

  const user = getOrCreateUser(event.params.user, event.block.timestamp);
  user.lastActivity = event.block.timestamp;
  user.save();
}

export function handleWithdrawExpired(event: WithdrawExpired): void {
  const withdrawal = new Withdrawal(eventId(event));
  withdrawal.user = event.params.user;
  withdrawal.amount = BigInt.zero();
  withdrawal.type = "expired";
  withdrawal.expiresAt = null;
  withdrawal.blockNumber = event.block.number;
  withdrawal.timestamp = event.block.timestamp;
  withdrawal.txHash = event.transaction.hash;
  withdrawal.save();

  const user = getOrCreateUser(event.params.user, event.block.timestamp);
  user.lastActivity = event.block.timestamp;
  user.save();
}

export function handleWithdrawFinalized(event: WithdrawFinalized): void {
  const amount = BigInt.fromU64(event.params.amount.toU64());

  const withdrawal = new Withdrawal(eventId(event));
  withdrawal.user = event.params.user;
  withdrawal.amount = amount;
  withdrawal.type = "finalized";
  withdrawal.expiresAt = null;
  withdrawal.blockNumber = event.block.number;
  withdrawal.timestamp = event.block.timestamp;
  withdrawal.txHash = event.transaction.hash;
  withdrawal.save();

  // Update User
  const user = getOrCreateUser(event.params.user, event.block.timestamp);
  user.totalWithdrawn = user.totalWithdrawn.plus(amount);
  user.lastActivity = event.block.timestamp;
  user.save();

  // Update PoolStats
  const stats = getOrCreateStats();
  stats.totalWithdrawals = stats.totalWithdrawals.plus(amount);
  if (amount.gt(BigInt.zero())) {
    stats.totalFees = stats.totalFees.plus(estimateFee(amount));
  }
  stats.save();
}

export function handleTreasuryUpdated(event: TreasuryUpdated): void {
  const action = new TreasuryAction(eventId(event));
  action.type = "updated";
  action.oldTreasury = event.params.oldTreasury;
  action.newTreasury = event.params.newTreasury;
  action.treasury = null;
  action.amount = null;
  action.blockNumber = event.block.number;
  action.timestamp = event.block.timestamp;
  action.txHash = event.transaction.hash;
  action.save();

  const stats = getOrCreateStats();
  stats.treasury = event.params.newTreasury;
  stats.save();
}

export function handleTreasuryWithdrawn(event: TreasuryWithdrawn): void {
  const amount = BigInt.fromU64(event.params.amount.toU64());

  const action = new TreasuryAction(eventId(event));
  action.type = "withdrawn";
  action.oldTreasury = null;
  action.newTreasury = null;
  action.treasury = event.params.treasury;
  action.amount = amount;
  action.blockNumber = event.block.number;
  action.timestamp = event.block.timestamp;
  action.txHash = event.transaction.hash;
  action.save();
}

export function handleOwnershipTransferStarted(event: OwnershipTransferStarted): void {
  const stats = getOrCreateStats();
  stats.pendingOwner = event.params.newOwner;
  stats.save();
}

export function handleOwnershipTransferred(event: OwnershipTransferred): void {
  const stats = getOrCreateStats();
  stats.currentOwner = event.params.newOwner;
  stats.pendingOwner = null;
  stats.save();
}

export function handleBalanceRequested(event: BalanceRequested): void {
  const user = getOrCreateUser(event.params.user, event.block.timestamp);
  user.lastActivity = event.block.timestamp;
  user.save();
}

export function handlePoolCapUpdated(event: PoolCapUpdated): void {
  const capUpdate = new CapUpdate(eventId(event));
  capUpdate.maxPoolBalance = event.params.maxPoolBalance;
  capUpdate.maxUserDeposit = event.params.maxUserDeposit;
  capUpdate.blockNumber = event.block.number;
  capUpdate.timestamp = event.block.timestamp;
  capUpdate.txHash = event.transaction.hash;
  capUpdate.save();

  const stats = getOrCreateStats();
  stats.maxPoolBalance = event.params.maxPoolBalance;
  stats.maxUserDeposit = event.params.maxUserDeposit;
  stats.save();
}

export function handlePaused(event: Paused): void {
  const stats = getOrCreateStats();
  stats.isPaused = true;
  stats.save();
}

export function handleUnpaused(event: Unpaused): void {
  const stats = getOrCreateStats();
  stats.isPaused = false;
  stats.save();
}
