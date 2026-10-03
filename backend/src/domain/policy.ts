// 违约记录对后续预约权限与押金规则的影响（纯函数）。
// 燃油车占用充电位且无有效预约：登记违约 -> 扣信用、扣押金、不足挂账追缴；
// 再次预约时校验：有未结清欠款 / 信用过低直接封禁，有违约史则提高押金门槛。

export const DEPOSIT_POLICY = {
  standard: 0, // 信用良好无违约史：免押金
  elevated: 200, // 有严重占位违约史后的押金门槛
  blockCreditBelow: 60, // 信用分低于该值禁止预约
  lookbackDays: 180, // 违约史回溯窗口
};

// 各类违约的罚金与信用影响（无有效预约时按此登记）
export const VIOLATION_RULES: Record<
  string,
  { fine: number; creditDelta: number; label: string }
> = {
  ice_occupy_charger: { fine: 200, creditDelta: -10, label: '燃油车占用充电位' },
  stranger_occupy: { fine: 100, creditDelta: -10, label: '陌生车辆占用预约车位' },
  wrong_parking: { fine: 50, creditDelta: -10, label: '停错车位' },
  overstay: { fine: 30, creditDelta: -3, label: '超时占用' },
  other: { fine: 0, creditDelta: 0, label: '其他违约' },
};

export interface ViolationSummary {
  type: string;
  hasValidReservation: boolean;
  createdAt: Date | string;
}

export interface DepositDecision {
  allowed: boolean;
  requiredDeposit: number;
  currentDeposit: number;
  shortfall: number; // 需补缴押金
  reasons: string[];
}

/**
 * 根据信用分、押金余额、未结清欠款与近期违约史决定能否预约及所需押金。
 */
export function decideReservationAccess(input: {
  creditScore: number;
  depositBalance: number;
  outstandingAmount: number;
  violations: ViolationSummary[];
  now?: Date;
}): DepositDecision {
  const reasons: string[] = [];
  const now = input.now ?? new Date();
  const recent = input.violations.filter((v) => {
    const t = new Date(v.createdAt).getTime();
    return now.getTime() - t <= DEPOSIT_POLICY.lookbackDays * 86400000;
  });

  const severeRecent = recent.filter(
    (v) => !v.hasValidReservation && ['ice_occupy_charger', 'stranger_occupy'].includes(v.type),
  );

  let requiredDeposit = DEPOSIT_POLICY.standard;
  if (severeRecent.length > 0) {
    requiredDeposit = DEPOSIT_POLICY.elevated;
    reasons.push(
      `近 ${DEPOSIT_POLICY.lookbackDays} 天内存在 ${severeRecent.length} 次占位违约（无有效预约），押金门槛上浮至 ¥${requiredDeposit}`,
    );
  }

  if (input.outstandingAmount > 0) {
    reasons.push(`存在 ¥${round2(input.outstandingAmount)} 未结清违约欠款，补缴前不可预约`);
  }
  if (input.creditScore < DEPOSIT_POLICY.blockCreditBelow) {
    reasons.push(`信用分 ${input.creditScore} 低于 ${DEPOSIT_POLICY.blockCreditBelow}，预约权限已冻结`);
  }

  const shortfall = round2(Math.max(0, requiredDeposit - input.depositBalance));
  if (shortfall > 0) reasons.push(`押金余额 ¥${round2(input.depositBalance)}，需补足 ¥${shortfall} 后方可预约`);

  const blocked =
    input.outstandingAmount > 0 ||
    input.creditScore < DEPOSIT_POLICY.blockCreditBelow ||
    shortfall > 0;

  return {
    allowed: !blocked,
    requiredDeposit,
    currentDeposit: round2(input.depositBalance),
    shortfall,
    reasons,
  };
}

/**
 * 违约金优先从押金扣除，不足部分挂账追缴。
 */
export function applyFineToDeposit(input: { fine: number; depositBalance: number }) {
  const fine = round2(Math.max(0, input.fine));
  const deposit = round2(Math.max(0, input.depositBalance));
  const depositDeducted = round2(Math.min(fine, deposit));
  const outstanding = round2(fine - depositDeducted);
  return {
    depositDeducted,
    outstanding,
    remainingDeposit: round2(deposit - depositDeducted),
  };
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
