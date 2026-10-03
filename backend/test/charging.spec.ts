import { computeRechargeCompensation, buildViolationPenalty, checkBookingEligibility, CHARGING_RULES } from '../src/domain/charging';

describe('computeRechargeCompensation 补电补偿', () => {
  test('未充满：缺口电量补偿 + 等待时间补偿 + 替代桩绕行补偿', () => {
    const r = computeRechargeCompensation({
      targetChargePct: 90,
      actualChargePct: 40,
      batteryCapacityKwh: 60,
      blockedMinutes: 30,
      relocatedToAlternate: true,
    });
    expect(r.shortagePct).toBe(50);
    expect(r.shortageKwh).toBe(30);
    // 30kWh × 1.2 = 36；等待 30 分钟 × 0.3 = 9；替代桩 10
    expect(r.energyCompensation).toBeCloseTo(36, 2);
    expect(r.delayCompensation).toBeCloseTo(9, 2);
    expect(r.relocationAllowance).toBe(10);
    expect(r.total).toBeCloseTo(55, 2);
    expect(r.fullyCharged).toBe(false);
  });

  test('等待时间补偿受封顶限制', () => {
    const r = computeRechargeCompensation({
      targetChargePct: 80, actualChargePct: 70, batteryCapacityKwh: 50,
      blockedMinutes: 200, relocatedToAlternate: false,
    });
    expect(r.delayCompensation).toBeCloseTo(CHARGING_RULES.rechargeDelayCapMinutes * 0.3, 2);
  });

  test('已达到目标电量则不补偿', () => {
    const r = computeRechargeCompensation({
      targetChargePct: 80, actualChargePct: 90, batteryCapacityKwh: 60,
      blockedMinutes: 40, relocatedToAlternate: true,
    });
    expect(r.total).toBe(0);
    expect(r.fullyCharged).toBe(true);
  });
});

describe('buildViolationPenalty 燃油车违约与押金/权限阶梯', () => {
  test('首次、高信用、押金充足：没收押金、不限制预约', () => {
    const r = buildViolationPenalty({
      creditScore: 100, priorViolationCount: 0, depositBalance: 100, hasValidReservation: false,
    });
    expect(r.fine).toBe(CHARGING_RULES.iceOccupyFine);
    expect(r.creditDelta).toBe(-15);
    expect(r.depositDeducted).toBe(80);
    expect(r.receivable).toBe(0);
    expect(r.restriction).toBe('none');
  });

  test('信用跌破 80：限制预约（不可约充电/月租位 7 天）', () => {
    const r = buildViolationPenalty({
      creditScore: 90, priorViolationCount: 0, depositBalance: 100, hasValidReservation: false,
    });
    expect(r.restriction).toBe('restricted');
    expect(r.restrictionDays).toBe(7);
  });

  test('累犯两次或信用跌破 60：停约 30 天', () => {
    const r1 = buildViolationPenalty({
      creditScore: 100, priorViolationCount: 2, depositBalance: 100, hasValidReservation: false,
    });
    expect(r1.restriction).toBe('blocked');
    expect(r1.restrictionDays).toBe(30);
    const r2 = buildViolationPenalty({
      creditScore: 70, priorViolationCount: 0, depositBalance: 100, hasValidReservation: false,
    });
    expect(r2.restriction).toBe('blocked');
  });

  test('押金不足：没收部分押金，余额挂账追缴并停约至补缴', () => {
    const r = buildViolationPenalty({
      creditScore: 100, priorViolationCount: 0, depositBalance: 30, hasValidReservation: false,
    });
    expect(r.depositDeducted).toBe(30);
    expect(r.receivable).toBe(50);
    expect(r.restriction).toBe('blocked');
  });

  test('占用车持有效预约：不按燃油车违约处罚', () => {
    const r = buildViolationPenalty({
      creditScore: 100, priorViolationCount: 0, depositBalance: 100, hasValidReservation: true,
    });
    expect(r.fine).toBe(0);
    expect(r.creditDelta).toBe(0);
    expect(r.restriction).toBe('none');
  });
});

describe('checkBookingEligibility 后续预约权限', () => {
  test('停约期内全部不可约', () => {
    expect(checkBookingEligibility([{ restriction: 'blocked', nearCharger: false, monthlyPriority: false }], { nearCharger: false, monthlyPriority: false }).ok).toBe(false);
  });
  test('限制期内不可约充电位，但可约普通位', () => {
    const active = [{ restriction: 'restricted' as const, nearCharger: true, monthlyPriority: false }];
    expect(checkBookingEligibility(active, { nearCharger: true, monthlyPriority: false }).ok).toBe(false);
    expect(checkBookingEligibility(active, { nearCharger: false, monthlyPriority: false }).ok).toBe(true);
  });
  test('无违约可自由预约', () => {
    expect(checkBookingEligibility([], { nearCharger: true, monthlyPriority: true }).ok).toBe(true);
  });
});
