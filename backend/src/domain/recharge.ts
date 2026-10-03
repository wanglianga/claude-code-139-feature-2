// 补电补偿（充电车位被燃油车错占，新能源车因此未充满）：
// 按"未充满电量缺口"计算补偿：电费损失 + 另行找桩/等待成本，平台先行赔付，后向违约车主追缴。
// 纯函数，便于单元测试。

import { PRICING } from './pricing';

export const RECHARGE_COMP = {
  pricePerKwh: PRICING.chargerPricePerKwh, // 与充电服务费同价 1.2 元/kWh
  // 补偿倍率：1.0 为电费等价赔偿，0.5 为另行寻找充电桩/排队等待的附加补偿
  multiplier: 1.5,
  cap: 120, // 单笔补电补偿封顶
};

export interface RechargeInput {
  requestedKwh: number; // 预约时期望充入的电量（充满所需）
  actualKwh: number; // 本次实际充入电量（含在替代充电桩补的电量）
}

export interface RechargeResult {
  kwhGap: number; // 未充满电量缺口
  energyLoss: number; // 电费损失（缺口 × 单价）
  surcharge: number; // 找桩/等待附加补偿
  compensation: number; // 补电补偿合计（封顶后）
  capped: boolean;
  notes: string[];
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function calcRechargeCompensation(input: RechargeInput): RechargeResult {
  const notes: string[] = [];
  const requested = Math.max(0, Number(input.requestedKwh) || 0);
  const actual = Math.max(0, Number(input.actualKwh) || 0);
  const kwhGap = round2(Math.max(0, requested - actual));

  if (kwhGap <= 0) {
    return { kwhGap: 0, energyLoss: 0, surcharge: 0, compensation: 0, capped: false, notes: ['充电量已达到预期，无补电补偿'] };
  }

  const energyLoss = round2(kwhGap * RECHARGE_COMP.pricePerKwh);
  const surcharge = round2(energyLoss * (RECHARGE_COMP.multiplier - 1));
  let compensation = round2(energyLoss + surcharge);
  let capped = false;
  if (compensation > RECHARGE_COMP.cap) {
    compensation = RECHARGE_COMP.cap;
    capped = true;
  }
  notes.push(
    `未充满电量缺口 ${kwhGap}kWh：电费损失 ¥${energyLoss}（${kwhGap}×${RECHARGE_COMP.pricePerKwh}）` +
      `，另行找桩/等待附加补偿 ¥${surcharge}`,
  );
  if (capped) notes.push(`补电补偿单笔封顶 ¥${RECHARGE_COMP.cap}`);
  notes.push('补电补偿由平台先行赔付给新能源车主，随后向占位违约车主追缴');
  return { kwhGap, energyLoss, surcharge, compensation, capped, notes };
}
