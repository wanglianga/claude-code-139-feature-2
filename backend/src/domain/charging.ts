// 充电车位错占领域规则（纯函数，便于单元测试）：
// 1) 新能源车因燃油车错占未充满时的「补电补偿」计算；
// 2) 燃油车无有效预约占用充电位的违约金、押金没收、挂账追缴、信用与后续预约权限阶梯；
// 3) 后续预约资格判定（违约记录限制充电位/月租预约或全面停约）。

export const CHARGING_RULES = {
  // 充电服务费单价（与 pricing.ts 保持一致），未充满的电量按此单价补偿补电服务费
  rechargeServicePricePerKwh: 1.2,
  // 等待挪车 / 改派替代桩期间的时间补偿（元/分钟），封顶 60 分钟
  rechargeDelayRatePerMinute: 0.3,
  rechargeDelayCapMinutes: 60,
  // 安排替代充电桩后车主仍需绕行的一次性交通补偿
  alternateChargerAllowance: 10,
  // 燃油车占用充电位违约金（无有效预约）
  iceOccupyFine: 80,
  // 单次违约信用扣减
  iceOccupyCreditDelta: -15,
  // 阶梯限制的天数
  restrictedDays: 7,
  blockedDays: 30,
  // 信用阶梯阈值
  restrictedCreditFloor: 80,
  blockedCreditFloor: 60,
};

export type Disposition = 'move_notice' | 'alternate_charger' | 'waive_fee';

export interface RechargeInput {
  targetChargePct: number; // 预约目标电量百分比（如 90）
  actualChargePct: number; // 离场实际充到的电量百分比（如 40）
  batteryCapacityKwh: number; // 车辆电池容量 kWh
  blockedMinutes: number; // 因错占等待挪车 / 协调替代桩被耽误的分钟数
  relocatedToAlternate: boolean; // 是否被安排到替代充电桩
}

export interface RechargeBreakdown {
  shortagePct: number;
  shortageKwh: number;
  energyCompensation: number; // 未充满电量的补电服务费补偿（现金）
  delayCompensation: number; // 等待 / 改派时间补偿（现金）
  relocationAllowance: number; // 替代桩绕行交通补偿（现金）
  total: number;
  fullyCharged: boolean;
  reasons: string[];
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * 计算补电补偿。未充满（actual < target）时：
 *  - 能量补偿 = 缺口电量 × 补电服务费单价（车主去他处补电的服务成本）
 *  - 时间补偿 = min(耽误分钟, 封顶) × 单价
 *  - 改派替代桩仍绕行：一次性交通补偿
 */
export function computeRechargeCompensation(input: RechargeInput): RechargeBreakdown {
  const reasons: string[] = [];
  const target = Math.max(0, Math.min(100, Number(input.targetChargePct) || 0));
  const actual = Math.max(0, Math.min(100, Number(input.actualChargePct) || 0));
  const capacity = Math.max(0, Number(input.batteryCapacityKwh) || 0);
  const blocked = Math.max(0, Number(input.blockedMinutes) || 0);

  const shortagePct = Math.max(0, target - actual);
  const shortageKwh = round2((capacity * shortagePct) / 100);
  const fullyCharged = shortagePct <= 0;

  let energyCompensation = 0;
  let delayCompensation = 0;
  let relocationAllowance = 0;

  if (fullyCharged) {
    reasons.push('车辆已充至目标电量，无需补电补偿');
  } else {
    energyCompensation = round2(shortageKwh * CHARGING_RULES.rechargeServicePricePerKwh);
    reasons.push(
      `未充满：目标 ${target}% / 实际 ${actual}%，缺口 ${shortagePct}%（约 ${shortageKwh}kWh），` +
        `按 ${CHARGING_RULES.rechargeServicePricePerKwh} 元/kWh 补偿补电服务费 ¥${energyCompensation}`,
    );

    const billableMinutes = Math.min(blocked, CHARGING_RULES.rechargeDelayCapMinutes);
    if (billableMinutes > 0) {
      delayCompensation = round2(billableMinutes * CHARGING_RULES.rechargeDelayRatePerMinute);
      reasons.push(
        `因挪车/协调替代桩等待 ${Math.round(blocked)} 分钟（补偿封顶 ${CHARGING_RULES.rechargeDelayCapMinutes} 分钟），` +
          `时间补偿 ¥${delayCompensation}`,
      );
    }

    if (input.relocatedToAlternate) {
      relocationAllowance = CHARGING_RULES.alternateChargerAllowance;
      reasons.push(`已安排替代充电桩，车主仍需绕行，一次性交通补偿 ¥${relocationAllowance}`);
    }
  }

  return {
    shortagePct,
    shortageKwh,
    energyCompensation,
    delayCompensation,
    relocationAllowance,
    total: round2(energyCompensation + delayCompensation + relocationAllowance),
    fullyCharged,
    reasons,
  };
}

export type BookingRestriction = 'none' | 'restricted' | 'blocked';

export interface ViolationInput {
  creditScore: number; // 违约前信用分
  priorViolationCount: number; // 既往同类违约次数（不含本次）
  depositBalance: number; // 违约时押金余额
  hasValidReservation: boolean; // 占用车辆是否持有该充电位的有效预约
  fine?: number; // 可覆盖违约金（默认按燃油车占充电位标准）
}

export interface ViolationPenalty {
  fine: number;
  creditDelta: number;
  depositDeducted: number; // 从押金中没收（已实际收回）
  receivable: number; // 押金不足 / 无账号：平台挂账继续追缴
  restriction: BookingRestriction;
  restrictionDays: number;
  reasons: string[];
}

/**
 * 计算燃油车违约的资金与权限后果：
 *  - 无有效预约才处罚；有有效预约属于排期/引导问题，不在此处罚（转申诉归责）；
 *  - 违约金优先从押金没收，不足部分挂账追缴；
 *  - 信用 + 累犯次数决定后续预约权限：正常 / 限制（不可约充电位、月租位 7 天）/ 停约（30 天，需补足押金）。
 */
export function buildViolationPenalty(input: ViolationInput): ViolationPenalty {
  const reasons: string[] = [];
  const fine = input.fine ?? CHARGING_RULES.iceOccupyFine;
  const creditDelta = CHARGING_RULES.iceOccupyCreditDelta;
  const scoreAfter = Math.max(0, input.creditScore + creditDelta);

  let depositDeducted = 0;
  let receivable = 0;
  if (input.hasValidReservation) {
    reasons.push('占用车辆持有该充电位有效预约，属于排期/引导冲突，不按燃油车违约处罚，转申诉归责');
    return {
      fine: 0,
      creditDelta: 0,
      depositDeducted: 0,
      receivable: 0,
      restriction: 'none',
      restrictionDays: 0,
      reasons,
    };
  }

  const balance = Math.max(0, Number(input.depositBalance) || 0);
  depositDeducted = round2(Math.min(fine, balance));
  receivable = round2(fine - depositDeducted);
  reasons.push(
    `燃油车无有效预约占用充电位：违约金 ¥${fine}，信用 ${creditDelta}（${input.creditScore}→${scoreAfter}）`,
  );
  if (depositDeducted > 0) reasons.push(`从押金没收 ¥${depositDeducted}`);
  if (receivable > 0) reasons.push(`押金不足，剩余 ¥${receivable} 挂账，平台保留追缴权，补足押金前限制预约`);

  const repeat = Math.max(0, Number(input.priorViolationCount) || 0);
  let restriction: BookingRestriction = 'none';
  let restrictionDays = 0;
  if (scoreAfter < CHARGING_RULES.blockedCreditFloor || repeat >= 2) {
    restriction = 'blocked';
    restrictionDays = CHARGING_RULES.blockedDays;
    reasons.push(`触发停约阶梯（信用 ${scoreAfter} / 累计违约 ${repeat + 1} 次）：${restrictionDays} 天内不可预约，需补缴押金后方可恢复`);
  } else if (scoreAfter < CHARGING_RULES.restrictedCreditFloor || repeat >= 1) {
    restriction = 'restricted';
    restrictionDays = CHARGING_RULES.restrictedDays;
    reasons.push(`触发限制阶梯（信用 ${scoreAfter} / 累计违约 ${repeat + 1} 次）：${restrictionDays} 天内不可预约充电位与月租优先位`);
  } else {
    reasons.push('首次违约且信用仍高：暂不限制预约，记录在案，再犯升级');
  }

  // 押金不足产生挂账：补缴欠款前停约（押金规则直接约束预约权限）
  if (receivable > 0 && restriction !== 'blocked') {
    restriction = 'blocked';
    restrictionDays = CHARGING_RULES.blockedDays;
    reasons.push(`违约金未能由押金足额覆盖，¥${receivable} 挂账：补缴清前暂停全部预约权限`);
  }

  return { fine, creditDelta, depositDeducted, receivable, restriction, restrictionDays, reasons };
}

/**
 * 车主名下当前生效的违约限制决定其能否预约目标车位。
 * blocked：全部不可约；restricted：充电位 / 月租优先位不可约。
 */
export function checkBookingEligibility(
  active: { restriction: BookingRestriction; nearCharger: boolean; monthlyPriority: boolean }[],
  target: { nearCharger: boolean; monthlyPriority: boolean },
): { ok: boolean; reason?: string } {
  if (active.some((a) => a.restriction === 'blocked')) {
    return { ok: false, reason: '存在生效的停约违约记录：请补缴押金/挂账欠款后再预约' };
  }
  const restricted = active.find((a) => a.restriction === 'restricted');
  if (restricted && (target.nearCharger || target.monthlyPriority)) {
    return { ok: false, reason: '违约限制期内不可预约充电位/月租优先位，可改约普通车位' };
  }
  return { ok: true };
}
