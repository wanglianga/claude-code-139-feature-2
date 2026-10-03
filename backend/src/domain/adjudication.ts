// 错停申诉裁决：综合车牌识别、预约记录、现场照片、道闸日志、
// 业主回家时间、物业巡查记录六类证据，自动给出责任建议。

import { Ruling } from './pricing';

export type EvidenceSource =
  | 'plate_recognition'
  | 'reservation'
  | 'photo'
  | 'gate_log'
  | 'owner_home'
  | 'patrol'
  | 'appeal_statement'
  | 'signal'
  | 'charger_info'
  | 'gate_access';

export interface EvidenceItem {
  source: EvidenceSource;
  title?: string;
  capturedAt?: Date | null;
  content: string;
  // 结构化字段：识别证据可直接携带实际车位号，避免从文本猜测
  actualSpot?: string;
  expectedSpot?: string;
  // 证据指向：支持车主申诉 / 反驳车主申诉 / 中性
  stance?: 'support' | 'refute' | 'neutral';
  // 证据可信度 0~1（车牌识别置信度、巡查记录天然高可信等）
  confidence?: number;
}

export interface AdjudicationInput {
  reservedSpotCode: string;
  reservedPlate: string;
  actualPlate?: string | null;
  evidence: EvidenceItem[];
  // 系统侧关联的异常类型
  incidents: Array<{ type: string; started_at?: Date | null; resolved_at?: Date | null }>;
  reservationStart: Date;
  reservationEnd: Date;
  // 充电位错占：现场充电桩编号、占用车辆是否为燃油车、该占用车是否持有有效预约
  appealType?: 'wrong_parking' | 'ice_charger';
  chargerCode?: string | null;
  occupierIsIce?: boolean;
  occupierHasReservation?: boolean;
}

export interface AdjudicationResult {
  ruling: Ruling;
  confidence: number; // 0~1
  scorecard: Record<string, number>;
  reasons: string[];
  evidenceTimeline: Array<{ at: Date | null; source: EvidenceSource; content: string }>;
  autoCreditDelta: number;
  occupierPlate?: string | null;
}

const SOURCE_WEIGHT: Record<EvidenceSource, number> = {
  plate_recognition: 0.9,
  gate_access: 0.88,
  gate_log: 0.85,
  patrol: 0.8,
  charger_info: 0.78,
  photo: 0.7,
  owner_home: 0.75,
  reservation: 0.6,
  signal: 0.5,
  appeal_statement: 0.3,
};

export function adjudicateAppeal(input: AdjudicationInput): AdjudicationResult {
  const reasons: string[] = [];
  const scorecard: Record<string, number> = {
    driver_fault: 0,
    owner_fault: 0,
    platform_fault: 0,
    property_fault: 0,
    stranger: 0,
  };

  const plateMismatch =
    !!input.actualPlate && normalize(input.actualPlate) !== normalize(input.reservedPlate);

  // ---- 充电位被燃油车错占：以充电桩编号 + 入场记录 + 现场照片形成闭环 ----
  let occupierPlate: string | null = input.actualPlate ?? null;
  if (input.appealType === 'ice_charger') {
    const chargerEv = input.evidence.find((e) => e.source === 'charger_info');
    const accessEv = input.evidence.find((e) => e.source === 'gate_access');
    const photoEv = input.evidence.find((e) => e.source === 'photo');
    const patrolIce = input.evidence.find(
      (e) => e.source === 'patrol' && /燃油|油车|ICE|非新能源|占用/i.test(e.content),
    );
    if (accessEv && !occupierPlate) {
      occupierPlate = accessEv.content.match(/[一-龥][A-Z][A-Z0-9]{4,6}/)?.[0] ?? null;
    }
    let iceScore = 0;
    if (chargerEv) {
      iceScore += SOURCE_WEIGHT.charger_info;
      reasons.push(`现场充电桩编号核验：${chargerEv.content}（预约车位确为带桩充电位）`);
    }
    if (accessEv) {
      iceScore += SOURCE_WEIGHT.gate_access;
      reasons.push(`调取占用车辆入场记录：${accessEv.content}`);
    }
    if (photoEv) {
      iceScore += SOURCE_WEIGHT.photo * 0.8;
      reasons.push('现场照片显示充电位被非新能源车辆占用');
    }
    if (patrolIce) {
      iceScore += SOURCE_WEIGHT.patrol;
      reasons.push('物业巡查确认燃油车占用充电位：' + patrolIce.content);
    }
    if (input.occupierHasReservation) {
      // 占用车持有效预约：属排期/引导冲突，不判陌生车主，转混合或物业平台责任
      scorecard.mixed += iceScore * 0.6;
      reasons.push('占用车辆持有该充电位有效预约，属排期/引导冲突，不由该车主承担违约责任');
    } else {
      // 无有效预约的燃油车：陌生车主责任（肇事燃油车主），平台先行兜底后追缴
      scorecard.stranger += iceScore;
      reasons.push(
        `占用车辆（${occupierPlate ?? '车牌待核'}）为燃油车且无该充电位有效预约，` +
          '判定肇事燃油车主责任：平台先行赔付新能源车主并向其追缴，记录违约、影响预约权限与押金',
      );
    }
  }

  // ---- 车牌识别证据 ----
  const recognitions = input.evidence.filter((e) => e.source === 'plate_recognition');
  for (const e of recognitions) {
    const w = SOURCE_WEIGHT.plate_recognition * (e.confidence ?? 0.8);
    const showsReservedCar = normalize(e.content).includes(normalize(input.reservedPlate));
    const actualSpot = e.actualSpot ?? e.content.match(/[A-Z]\d?-?\d{3,4}/i)?.[0] ?? null;
    const wrongSpotMention = !!actualSpot && actualSpot.toUpperCase() !== input.reservedSpotCode.toUpperCase();
    if (e.stance === 'refute' && showsReservedCar && wrongSpotMention) {
      // 拍到的就是预约车辆本人，但车位编号与预约不符 -> 车主停错
      scorecard.driver_fault += w;
      reasons.push(`车牌识别（置信度 ${((e.confidence ?? 0.8) * 100).toFixed(0)}%）拍到预约车辆停在 ${actualSpot}，预约车位为 ${input.reservedSpotCode}`);
    } else if (plateMismatch && e.stance !== 'support' && showsReservedCar && e.content.includes(input.reservedSpotCode)) {
      scorecard.driver_fault += w;
      reasons.push(`车牌识别（置信度 ${((e.confidence ?? 0.8) * 100).toFixed(0)}%）显示车辆停在非预约车位`);
    } else if (e.stance === 'refute' && !showsReservedCar) {
      scorecard.stranger += w;
      reasons.push('车牌识别到非预约车辆占用预约车位');
    } else if (plateMismatch && e.stance !== 'support') {
      scorecard.stranger += w;
      reasons.push('车牌识别到预约车辆以外的陌生车牌占用该车位');
    } else if (e.stance === 'support') {
      scorecard.platform_fault += w * 0.5;
      reasons.push('车牌识别记录支持车主陈述');
    }
  }

  // ---- 道闸日志：识别失败/人工放行 ----
  const gateLogs = input.evidence.filter((e) => e.source === 'gate_log');
  let manualRelease = false;
  let recognitionFail = false;
  for (const e of gateLogs) {
    if (/人工放行|manual/i.test(e.content)) {
      // 人工放行本身是中性操作（识别失败时的正当兜底）；
      // 仅当陌生车经人工放行进入时才计入物业过失（见下方组合规则）
      manualRelease = true;
    }
    if (/识别失败|无匹配|重试失败/i.test(e.content)) {
      recognitionFail = true;
      scorecard.platform_fault += SOURCE_WEIGHT.gate_log * 0.6;
      reasons.push('道闸发生车牌识别失败，可能导致引导/入场异常');
    }
  }

  // ---- 物业巡查记录 ----
  const patrols = input.evidence.filter((e) => e.source === 'patrol');
  for (const e of patrols) {
    const w = SOURCE_WEIGHT.patrol;
    if (/陌生|非预约|占用/i.test(e.content)) {
      scorecard.stranger += w;
      reasons.push('物业巡查发现陌生车辆占用：' + e.content);
    } else if (/停错|错位|引导错误/i.test(e.content)) {
      scorecard.driver_fault += w * 0.5;
      scorecard.property_fault += w * 0.5;
      reasons.push('巡查记录显示引导/停位存在混合责任');
    } else if (e.stance === 'support') {
      scorecard.platform_fault += w * 0.4;
      reasons.push('物业巡查记录支持车主陈述：' + e.content);
    }
  }

  // ---- 业主回家时间 ----
  const ownerHome = input.evidence.find((e) => e.source === 'owner_home');
  if (ownerHome) {
    const t = ownerHome.capturedAt ?? input.reservationStart;
    if (t >= input.reservationStart && t < input.reservationEnd) {
      scorecard.owner_fault += SOURCE_WEIGHT.owner_home;
      reasons.push(`业主于 ${fmt(t)} 在共享时段内临时回家，共享服务被迫中断`);
    }
  }
  if (input.incidents.some((i) => i.type === 'owner_return')) {
    scorecard.owner_fault += 0.4;
  }

  // ---- 现场照片 ----
  const photos = input.evidence.filter((e) => e.source === 'photo');
  for (const e of photos) {
    if (/车位号|编号|标牌/i.test(e.content) && plateMismatch) {
      scorecard.driver_fault += SOURCE_WEIGHT.photo * 0.6;
      reasons.push('现场照片显示车位编号与预约不符');
    }
    if (/陌生|其他车辆|非本人/i.test(e.content)) {
      scorecard.stranger += SOURCE_WEIGHT.photo * 0.6;
    }
    if (e.stance === 'support') {
      scorecard.platform_fault += SOURCE_WEIGHT.photo * 0.3;
    }
  }

  // ---- 信号差（平台服务瑕疵，削弱车主过错）----
  if (input.incidents.some((i) => i.type === 'weak_signal')) {
    scorecard.platform_fault += SOURCE_WEIGHT.signal;
    reasons.push('地下车库信号差导致导航引导中断，平台承担部分服务责任');
  }
  if (input.evidence.some((e) => e.source === 'signal')) {
    scorecard.platform_fault += 0.3;
  }

  // ---- 预约记录：时间窗匹配性 ----
  const reservationEv = input.evidence.find((e) => e.source === 'reservation');
  if (reservationEv && reservationEv.stance === 'support') {
    scorecard.platform_fault += 0.2;
    reasons.push('预约记录与车主陈述时间吻合');
  }

  // ---- 陈述（低权重）----
  const stmt = input.evidence.find((e) => e.source === 'appeal_statement');
  if (stmt?.stance === 'support') reasons.push('车主陈述：' + stmt.content);

  // 人工放行了陌生车：物业责任上调
  if (manualRelease && scorecard.stranger > 0) {
    scorecard.property_fault += 0.5;
    reasons.push('陌生车经人工放行进入，物业放行审核存在过失');
  }
  if (recognitionFail && !plateMismatch && scorecard.driver_fault === 0) {
    scorecard.platform_fault += 0.3;
  }

  // ---- 归一化与裁决 ----
  const total = Object.values(scorecard).reduce((a, b) => a + b, 0);
  let ruling: Ruling = 'no_fault';
  let confidence = 0;
  if (total > 0) {
    const ranked = Object.entries(scorecard).sort((a, b) => b[1] - a[1]);
    const [top, topScore] = ranked[0];
    const [, secondScore] = ranked[1];
    confidence = Math.min(0.95, topScore / total + 0.3);
    if (topScore > 0 && secondScore / topScore > 0.65 && secondScore > 0.5) {
      ruling = 'mixed';
      confidence = topScore / total + 0.2;
    } else {
      ruling = top as Ruling;
    }
  } else {
    // 无任何指向性证据时默认存疑不作处罚，转人工
    reasons.push('证据不足，建议人工复核；系统不作自动处罚');
    ruling = 'no_fault';
    confidence = 0.2;
  }

  const autoCreditDelta =
    ruling === 'driver_fault'
      ? -10
      : ruling === 'stranger'
        ? -10
        : ruling === 'mixed'
          ? -5
          : ruling === 'owner_fault' || ruling === 'property_fault'
            ? -5
            : 0;

  const evidenceTimeline = input.evidence
    .map((e) => ({ at: e.capturedAt ?? null, source: e.source, content: e.content }))
    .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));

  return {
    ruling,
    confidence: Math.round(confidence * 100) / 100,
    scorecard: Object.fromEntries(Object.entries(scorecard).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    reasons,
    evidenceTimeline,
    autoCreditDelta,
    occupierPlate,
  };
}

function normalize(plate: string) {
  return plate.replace(/[^0-9A-Z一-龥]/gi, '').toUpperCase();
}

function fmt(d: Date) {
  return new Date(d).toLocaleString('zh-CN', { hour12: false });
}
