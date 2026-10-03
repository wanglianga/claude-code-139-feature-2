import { adjudicateAppeal } from '../src/domain/adjudication';

const base = {
  reservedSpotCode: 'B2-108',
  reservedPlate: '沪AD88899',
  actualPlate: '沪AD88899',
  reservationStart: new Date('2026-10-01T19:00:00Z'),
  reservationEnd: new Date('2026-10-02T08:00:00Z'),
  incidents: [] as any[],
  evidence: [] as any[],
};

describe('adjudicateAppeal', () => {
  test('车牌识别+停放核验证明车辆停在非预约车位 → 车主责任', () => {
    const r = adjudicateAppeal({
      ...base,
      actualPlate: '沪AD88899',
      evidence: [
        {
          source: 'plate_recognition',
          title: '停放核验',
          content: '识别车牌 沪AD88899 停在车位 B2-109',
          capturedAt: new Date('2026-10-01T19:10:00Z'),
          stance: 'refute',
          confidence: 0.95,
        },
      ],
    });
    expect(r.ruling).toBe('driver_fault');
    expect(r.autoCreditDelta).toBe(-10);
  });

  test('业主在共享时段内回家 + 车主陈述 → 业主责任', () => {
    const r = adjudicateAppeal({
      ...base,
      evidence: [
        {
          source: 'owner_home',
          title: '业主回家时间',
          content: '业主 22:00 临时回家',
          capturedAt: new Date('2026-10-01T22:00:00Z'),
          stance: 'support',
        },
        { source: 'appeal_statement', title: '陈述', content: '被要求挪车', stance: 'support' },
      ],
      incidents: [{ type: 'owner_return', started_at: new Date('2026-10-01T22:00:00Z') }],
    });
    expect(r.ruling).toBe('owner_fault');
  });

  test('物业巡查发现陌生车 + 人工放行 → 陌生车责任，物业承担放行过失（混合）', () => {
    const r = adjudicateAppeal({
      ...base,
      actualPlate: '沪X00000',
      evidence: [
        { source: 'patrol', title: '巡查', content: '发现陌生车辆占用 B2-108', stance: 'neutral' },
        { source: 'gate_log', title: '道闸', content: '人工放行进场地库', stance: 'neutral' },
      ],
    });
    expect(['stranger', 'mixed']).toContain(r.ruling);
    expect(r.reasons.some((x) => x.includes('人工放行'))).toBe(true);
  });

  test('识别失败 + 信号差 → 平台责任', () => {
    const r = adjudicateAppeal({
      ...base,
      evidence: [
        { source: 'gate_log', title: '道闸', content: '识别失败，无匹配重试失败', stance: 'support' },
        { source: 'signal', title: '信号', content: 'B2 无网络', stance: 'support' },
      ],
      incidents: [{ type: 'weak_signal' }, { type: 'recognition_fail' }],
    });
    expect(r.ruling).toBe('platform_fault');
    expect(r.autoCreditDelta).toBe(0);
  });

  test('证据不足时不作自动处罚，转人工', () => {
    const r = adjudicateAppeal({ ...base, evidence: [] });
    expect(r.ruling).toBe('no_fault');
    expect(r.confidence).toBeLessThan(0.5);
  });

  test('证据按时间排序形成时间线', () => {
    const r = adjudicateAppeal({
      ...base,
      evidence: [
        { source: 'signal', content: '晚些', capturedAt: new Date('2026-10-01T22:00:00Z') },
        { source: 'gate_log', content: '早些', capturedAt: new Date('2026-10-01T19:00:00Z') },
      ],
    });
    expect(r.evidenceTimeline[0].source).toBe('gate_log');
    expect(r.evidenceTimeline[1].source).toBe('signal');
  });

  test('充电位被燃油车占用：系统入场记录+工单 → 陌生占位车主责任', () => {
    const r = adjudicateAppeal({
      ...base,
      actualPlate: '沪A12345',
      evidence: [
        {
          source: 'gate_log',
          title: '占用车辆道闸入场记录（系统自动调取）',
          content: '道闸入场记录：燃油车 沪A12345 识别放行入场；核对预约系统：该车无有效预约',
          capturedAt: new Date('2026-10-01T18:50:00Z'),
          stance: 'support',
        },
      ],
      incidents: [{ type: 'ice_occupy_charger', started_at: new Date('2026-10-01T19:00:00Z') }],
    });
    expect(r.ruling).toBe('stranger');
    expect(r.reasons.some((x) => x.includes('燃油车'))).toBe(true);
  });
});
