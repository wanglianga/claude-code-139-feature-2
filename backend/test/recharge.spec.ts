import { calcRechargeCompensation, RECHARGE_COMP } from '../src/domain/recharge';

describe('calcRechargeCompensation', () => {
  test('已充满（无缺口）无补偿', () => {
    const r = calcRechargeCompensation({ requestedKwh: 40, actualKwh: 40 });
    expect(r.kwhGap).toBe(0);
    expect(r.compensation).toBe(0);
  });

  test('实际充得更少不产生负缺口', () => {
    const r = calcRechargeCompensation({ requestedKwh: 10, actualKwh: 30 });
    expect(r.kwhGap).toBe(0);
  });

  test('未充满缺口按 1.2 元/kWh × 1.5 倍计算补偿', () => {
    // 缺口 30kWh：电费 36 元 + 50% 找桩附加 18 元 = 54 元
    const r = calcRechargeCompensation({ requestedKwh: 40, actualKwh: 10 });
    expect(r.kwhGap).toBe(30);
    expect(r.energyLoss).toBe(36);
    expect(r.surcharge).toBe(18);
    expect(r.compensation).toBe(54);
    expect(r.notes.some((n) => n.includes('先行赔付'))).toBe(true);
  });

  test('补偿受单笔封顶约束', () => {
    const r = calcRechargeCompensation({ requestedKwh: 200, actualKwh: 0 });
    expect(r.capped).toBe(true);
    expect(r.compensation).toBe(RECHARGE_COMP.cap);
  });
});
