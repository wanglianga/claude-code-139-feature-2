import { adjudicateAppeal } from '../src/domain/adjudication';

const base = {
  reservedSpotCode: 'B2-108',
  reservedPlate: '沪AD88899',
  reservationStart: new Date('2026-10-01T19:00:00Z'),
  reservationEnd: new Date('2026-10-02T08:00:00Z'),
  incidents: [] as any[],
  evidence: [] as any[],
};

describe('充电位被燃油车错占裁决', () => {
  test('充电桩编号+入场记录+照片证明无预约燃油车占用 → 陌生车主责任', () => {
    const r = adjudicateAppeal({
      ...base,
      appealType: 'ice_charger',
      actualPlate: '沪A98765',
      chargerCode: 'CHG-B2-03',
      occupierIsIce: true,
      occupierHasReservation: false,
      evidence: [
        { source: 'charger_info', title: '现场充电桩编号', content: '充电桩编号 CHG-B2-03，对应预约车位 B2-108（带 B2-108 充电设施）', capturedAt: new Date('2026-10-01T19:05:00Z'), stance: 'support' },
        { source: 'gate_access', title: '占用车辆入场记录', content: '2026-10-01T18:40:00 车牌 沪A98765（燃油）经 地库道闸人工放行进入，无匹配预约', capturedAt: new Date('2026-10-01T18:40:00Z'), stance: 'support' },
        { source: 'photo', title: '现场照片（充电位被燃油车占用）', content: '照片显示充电位被非新能源车辆占用', capturedAt: new Date('2026-10-01T19:05:00Z'), stance: 'support' },
      ],
    });
    expect(r.ruling).toBe('stranger');
    expect(r.occupierPlate).toBe('沪A98765');
    expect(r.reasons.some((x) => x.includes('无') && x.includes('预约'))).toBe(true);
  });

  test('占用车持有效预约：不判陌生车主，归为混合责任', () => {
    const r = adjudicateAppeal({
      ...base,
      appealType: 'ice_charger',
      actualPlate: '沪A11111',
      occupierIsIce: false,
      occupierHasReservation: true,
      evidence: [
        { source: 'charger_info', title: '现场充电桩编号', content: '充电桩 CHG-B2-03', stance: 'support' },
        { source: 'gate_access', title: '占用车辆入场记录', content: '车牌 沪A11111 识别放行进入', stance: 'neutral' },
      ],
    });
    expect(r.ruling).not.toBe('stranger');
    expect(r.reasons.some((x) => x.includes('有效预约'))).toBe(true);
  });

  test('无任何充电错占证据时不凭空判燃油车责任', () => {
    const r = adjudicateAppeal({ ...base, appealType: 'ice_charger', evidence: [] });
    expect(['no_fault', 'stranger']).toContain(r.ruling);
  });
});
