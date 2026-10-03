import { applyFineToDeposit, decideReservationAccess } from '../src/domain/policy';

const now = new Date('2026-10-02T20:00:00Z');
const recentIce = { type: 'ice_occupy_charger', hasValidReservation: false, createdAt: now };

describe('decideReservationAccess', () => {
  test('信用良好、无违约史：免押金可预约', () => {
    const d = decideReservationAccess({
      creditScore: 100,
      depositBalance: 0,
      outstandingAmount: 0,
      violations: [],
      now,
    });
    expect(d.allowed).toBe(true);
    expect(d.requiredDeposit).toBe(0);
    expect(d.shortfall).toBe(0);
  });

  test('有未结清欠款：禁止预约', () => {
    const d = decideReservationAccess({
      creditScore: 100,
      depositBalance: 0,
      outstandingAmount: 200,
      violations: [],
      now,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('未结清'))).toBe(true);
  });

  test('信用低于 60：冻结预约权限', () => {
    const d = decideReservationAccess({
      creditScore: 50,
      depositBalance: 500,
      outstandingAmount: 0,
      violations: [],
      now,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.some((r) => r.includes('冻结'))).toBe(true);
  });

  test('无有效预约的占位违约史：押金门槛上浮至 200，押金不足不可约', () => {
    const d = decideReservationAccess({
      creditScore: 90,
      depositBalance: 0,
      outstandingAmount: 0,
      violations: [recentIce],
      now,
    });
    expect(d.requiredDeposit).toBe(200);
    expect(d.shortfall).toBe(200);
    expect(d.allowed).toBe(false);

    const ok = decideReservationAccess({
      creditScore: 90,
      depositBalance: 200,
      outstandingAmount: 0,
      violations: [recentIce],
      now,
    });
    expect(ok.allowed).toBe(true);
  });

  test('占位时持有有效预约的记录不提高押金门槛', () => {
    const d = decideReservationAccess({
      creditScore: 100,
      depositBalance: 0,
      outstandingAmount: 0,
      violations: [{ ...recentIce, hasValidReservation: true }],
      now,
    });
    expect(d.requiredDeposit).toBe(0);
    expect(d.allowed).toBe(true);
  });

  test('超出回溯窗口的旧违约不再影响预约', () => {
    const d = decideReservationAccess({
      creditScore: 90,
      depositBalance: 0,
      outstandingAmount: 0,
      violations: [{ ...recentIce, createdAt: new Date(now.getTime() - 200 * 86400000) }],
      now,
    });
    expect(d.requiredDeposit).toBe(0);
    expect(d.allowed).toBe(true);
  });
});

describe('applyFineToDeposit', () => {
  test('押金充足：全额从押金扣除，无挂账', () => {
    const r = applyFineToDeposit({ fine: 200, depositBalance: 300 });
    expect(r.depositDeducted).toBe(200);
    expect(r.outstanding).toBe(0);
    expect(r.remainingDeposit).toBe(100);
  });

  test('押金不足：扣完押金后余额挂账追缴', () => {
    const r = applyFineToDeposit({ fine: 200, depositBalance: 50 });
    expect(r.depositDeducted).toBe(50);
    expect(r.outstanding).toBe(150);
    expect(r.remainingDeposit).toBe(0);
  });

  test('无押金：全额挂账', () => {
    const r = applyFineToDeposit({ fine: 200, depositBalance: 0 });
    expect(r.depositDeducted).toBe(0);
    expect(r.outstanding).toBe(200);
  });
});
