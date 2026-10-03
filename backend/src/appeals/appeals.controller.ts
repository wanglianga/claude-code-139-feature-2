import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';
import { adjudicateAppeal, AdjudicationResult, EvidenceItem } from '../domain/adjudication';
import { calcRechargeCompensation } from '../domain/recharge';
import { applyFineToDeposit, VIOLATION_RULES } from '../domain/policy';

class AddEvidenceDto {
  source: 'plate_recognition' | 'reservation' | 'photo' | 'gate_log' | 'owner_home' | 'patrol' | 'appeal_statement' | 'signal';
  title: string;
  content: string;
  media_url?: string;
  captured_at?: string;
  stance?: 'support' | 'refute' | 'neutral';
  confidence?: number;
}

class AppealPhotoDto {
  media_url: string;
  note?: string;
  captured_at?: string;
}

class CreateAppealDto {
  reservation_id: number;
  reason: string;
  evidence?: AddEvidenceDto[];
  // —— 充电车位错占申诉专项 ——
  appeal_type?: 'wrong_parking' | 'charging_occupy';
  charger_code?: string; // 现场充电桩编号
  arrived_at?: string; // 到达时间
  occupying_plate?: string; // 占用车位的燃油车车牌
  photos?: AppealPhotoDto[]; // 现场照片（必填至少 1 张）
  requested_kwh?: number; // 预约期望充电量（充满所需 kWh）
}

class HandleDto {
  action: 'contact_move' | 'alternative_charger' | 'waive_fee';
  alt_charger_code?: string;
  note?: string;
}

@Controller('appeals')
@UseGuards(AuthGuard)
export class AppealsController {
  constructor(private db: DbService) {}

  // 车主发起申诉（普通错停 / 充电车位被燃油车错占）
  @Roles('driver')
  @Post()
  async create(@CurrentUser() user: JwtUser, @Body() dto: CreateAppealDto) {
    return this.db.withTx(async (c) => {
      const r = await c.query(
        `SELECT r.*, s.code AS spot_code, s.owner_id, s.near_charger, s.charger_power_kw,
                v.is_new_energy
         FROM reservations r
         JOIN parking_spots s ON s.id=r.spot_id
         JOIN vehicles v ON v.id=r.vehicle_id
         WHERE r.id=$1 AND r.driver_id=$2 FOR UPDATE`,
        [dto.reservation_id, user.sub],
      );
      const reservation = r.rows[0];
      if (!reservation) throw new BadRequestException('预约不存在或不属于本人');

      const appealType = dto.appeal_type === 'charging_occupy' ? 'charging_occupy' : 'wrong_parking';
      let arrivedAt: Date | null = null;
      let recharge: ReturnType<typeof calcRechargeCompensation> | null = null;

      if (appealType === 'charging_occupy') {
        if (!reservation.near_charger) throw new BadRequestException('该预约车位不是带充电桩车位，不能发起充电位错占申诉');
        if (!reservation.is_new_energy) throw new BadRequestException('仅新能源预约车辆可发起充电位错占申诉');
        if (!dto.charger_code?.trim()) throw new BadRequestException('请填写现场充电桩编号');
        if (!dto.arrived_at) throw new BadRequestException('请填写到达时间');
        if (!dto.occupying_plate?.trim()) throw new BadRequestException('请填写占用车位的燃油车车牌');
        if (!dto.photos?.length) throw new BadRequestException('请至少上传一张现场照片');
        arrivedAt = new Date(dto.arrived_at);
        if (isNaN(arrivedAt.getTime())) throw new BadRequestException('到达时间格式非法');
        if (dto.requested_kwh != null && Number(dto.requested_kwh) < 0) throw new BadRequestException('期望充电量非法');
        recharge = calcRechargeCompensation({ requestedKwh: Number(dto.requested_kwh ?? 0), actualKwh: 0 });
      }

      const ins = await c.query(
        `INSERT INTO appeals(code, reservation_id, spot_id, appellant_id, reason, status,
           appeal_type, charger_code, arrived_at, occupying_plate, requested_kwh, actual_kwh,
           recharge_compensation)
         VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10,0,$11) RETURNING *`,
        [
          'A' + Date.now().toString(36).toUpperCase(),
          dto.reservation_id,
          reservation.spot_id,
          user.sub,
          dto.reason,
          appealType,
          dto.charger_code ?? null,
          arrivedAt,
          appealType === 'charging_occupy' ? normalizePlate(dto.occupying_plate!) : null,
          appealType === 'charging_occupy' ? Number(dto.requested_kwh ?? 0) : null,
          recharge?.compensation ?? 0,
        ],
      );
      const appeal = ins.rows[0];

      // 车主陈述 + 自行上传的通用证据
      await c.query(
        `INSERT INTO appeal_evidence(appeal_id, source, title, content, captured_at, uploaded_by)
         VALUES ($1,'appeal_statement',$2,$3, COALESCE($5::timestamptz, now()), $4)`,
        [appeal.id, '车主申诉陈述', dto.reason, user.sub, arrivedAt?.toISOString() ?? null],
      );
      for (const e of dto.evidence ?? []) {
        await c.query(
          `INSERT INTO appeal_evidence(appeal_id, source, title, content, media_url, captured_at, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            appeal.id,
            e.source,
            e.title,
            e.content,
            e.media_url ?? null,
            e.captured_at ? new Date(e.captured_at) : new Date(),
            user.sub,
          ],
        );
      }

      let entryRecord: any = null;
      if (appealType === 'charging_occupy') {
        // —— 现场照片入证据链 ——
        for (const [i, p] of dto.photos!.entries()) {
          await c.query(
            `INSERT INTO appeal_evidence(appeal_id, source, title, content, media_url, captured_at, uploaded_by)
             VALUES ($1,'photo',$2,$3,$4,$5,$6)`,
            [
              appeal.id,
              `现场照片 ${i + 1}（充电桩 ${dto.charger_code}）`,
              `照片显示燃油车 ${normalizePlate(dto.occupying_plate!)} 占用带充电桩车位，充电桩编号 ${dto.charger_code}；${p.note ?? ''}`.trim(),
              p.media_url,
              p.captured_at ? new Date(p.captured_at) : arrivedAt,
              user.sub,
            ],
          );
        }

        // —— 自动调取占用车辆的道闸入场记录 ——
        entryRecord = await this.fetchOccupyingEntry(
          c,
          reservation.spot_id,
          normalizePlate(dto.occupying_plate!),
          arrivedAt!,
        );
        const hasValid = !!entryRecord?.validReservation;
        const entryDesc = entryRecord?.entry
          ? entryRecord.entry.type === 'recognition_fail'
            ? `道闸记录：燃油车 ${normalizePlate(dto.occupying_plate!)} 于 ${entryRecord.entry.occurred_at} 在${entryRecord.entry.gate ?? '入口道闸'}识别无匹配/置信度低（疑似跟车入场），系统留存其入场影像记录；`
            : `道闸入场记录：燃油车 ${normalizePlate(dto.occupying_plate!)} 于 ${entryRecord.entry.occurred_at} 经${entryRecord.entry.gate ?? '入口道闸'}${entryRecord.entry.type === 'manual_release' ? '物业人工放行' : '车牌识别放行'}入场；`
          : `道闸入场记录：未检索到燃油车 ${normalizePlate(dto.occupying_plate!)} 的任何道闸事件（疑似跟车入场），已通知物业核查人工放行/跟车通道；`;
        const entryText =
          entryDesc +
          `核对预约系统：该车在申诉车位预约时段内${hasValid ? '存在有效预约（转人工核查）' : '无有效预约'}`;
        await c.query(
          `INSERT INTO appeal_evidence(appeal_id, source, title, content, captured_at, uploaded_by)
           VALUES ($1,'gate_log',$2,$3,$4,$5)`,
          [
            appeal.id,
            '占用车辆道闸入场记录（系统自动调取）',
            entryText + (entryRecord?.entry?.mode_note ? `；${entryRecord.entry.mode_note}` : ''),
            entryRecord?.entry?.occurred_at ?? arrivedAt,
            user.sub,
          ],
        );

        // —— 自动立"燃油车占用充电位"工单，进入物业调度看板 ——
        await this.upsertIceTicket(c, {
          spotId: reservation.spot_id,
          reservationId: reservation.id,
          plate: normalizePlate(dto.occupying_plate!),
          description: `新能源车主申诉：${arrivedAt?.toISOString()} 到达车位 ${reservation.spot_code}，充电桩 ${dto.charger_code} 被燃油车 ${normalizePlate(dto.occupying_plate!)} 占用`,
          detail: {
            appeal_id: appeal.id,
            charger_code: dto.charger_code,
            arrived_at: arrivedAt,
            has_valid_reservation: hasValid,
            gate: entryRecord?.entry?.gate ?? null,
            entry_at: entryRecord?.entry?.occurred_at ?? null,
          },
        });

        await c.query(
          `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
           VALUES ($1,$2,'charging_occupy_report',$3,'driver',$4,$5)`,
          [
            dto.reservation_id,
            reservation.spot_id,
            user.sub,
            normalizePlate(dto.occupying_plate!),
            JSON.stringify({
              appeal_id: appeal.id,
              charger_code: dto.charger_code,
              arrived_at: arrivedAt,
              has_valid_reservation: hasValid,
              recharge_preview: recharge,
            }),
          ],
        );
      }

      const result = await this.runAdjudication(c, appeal.id);
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,'appeal_submitted',$3,'driver',$4)`,
        [
          dto.reservation_id,
          reservation.spot_id,
          user.sub,
          JSON.stringify({ appeal_id: appeal.id, appeal_type: appealType, auto: result.ruling, confidence: result.confidence }),
        ],
      );
      return { appeal: await this.loadAppeal(c, appeal.id), adjudication: result, recharge_preview: recharge, occupying_entry: entryRecord };
    });
  }

  @Get()
  async list(@CurrentUser() user: JwtUser) {
    let where = '1=1';
    const params: any[] = [];
    if (user.role === 'driver') {
      params.push(user.sub);
      where = `a.appellant_id=$${params.length}`;
    } else if (user.role === 'owner') {
      params.push(user.sub);
      where = `s.owner_id=$${params.length}`;
    }
    return this.db
      .query(
        `SELECT a.*, r.code AS reservation_code, r.plate, s.code AS spot_code,
                u.name AS appellant_name
         FROM appeals a
         JOIN reservations r ON r.id=a.reservation_id
         JOIN parking_spots s ON s.id=a.spot_id
         JOIN users u ON u.id=a.appellant_id
         WHERE ${where}
         ORDER BY a.created_at DESC LIMIT 200`,
        params,
      )
      .then((q) => q.rows);
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const appeal = await this.db.query(
      `SELECT a.*, r.code AS reservation_code, r.plate, r.start_at AS reserved_start, r.end_at AS reserved_end,
              s.code AS spot_code, u.name AS appellant_name
       FROM appeals a
       JOIN reservations r ON r.id=a.reservation_id
       JOIN parking_spots s ON s.id=a.spot_id
       JOIN users u ON u.id=a.appellant_id
       WHERE a.id=$1`,
      [id],
    );
    if (!appeal.rows[0]) throw new BadRequestException('申诉不存在');
    const evidence = await this.db.query(
      `SELECT * FROM appeal_evidence WHERE appeal_id=$1 ORDER BY captured_at NULLS LAST, id`,
      [id],
    );
    const adjudication = await this.buildAdjudication(this.db, appeal.rows[0]);
    const violations = await this.db.query(`SELECT * FROM violation_records WHERE appeal_id=$1 ORDER BY id`, [id]);
    let occupyingEntry: { entry: any; reservations: any[]; validReservation: any } | null = null;
    if (appeal.rows[0].appeal_type === 'charging_occupy' && appeal.rows[0].occupying_plate) {
      occupyingEntry = await this.fetchOccupyingEntry(
        this.db,
        appeal.rows[0].spot_id,
        appeal.rows[0].occupying_plate,
        new Date(appeal.rows[0].arrived_at),
      );
    }
    // 补电补偿随实际充电量变化的实时试算
    let recharge: ReturnType<typeof calcRechargeCompensation> | null = null;
    if (appeal.rows[0].appeal_type === 'charging_occupy' && appeal.rows[0].requested_kwh != null) {
      const actual = await this.db.query(
        `SELECT detail FROM service_events WHERE reservation_id=$1 AND type='charging_session' ORDER BY id DESC LIMIT 1`,
        [appeal.rows[0].reservation_id],
      );
      recharge = calcRechargeCompensation({
        requestedKwh: Number(appeal.rows[0].requested_kwh),
        actualKwh: Number(actual.rows[0]?.detail?.kwh ?? appeal.rows[0].actual_kwh ?? 0),
      });
    }
    return {
      ...appeal.rows[0],
      evidence: evidence.rows,
      adjudication,
      violations: violations.rows,
      occupying_entry: occupyingEntry,
      recharge_preview: recharge,
    };
  }

  // 追加证据（物业巡查照片、业主上传回家凭证等）
  @Post(':id/evidence')
  async addEvidence(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: AddEvidenceDto) {
    const a = await this.db.query(`SELECT * FROM appeals WHERE id=$1`, [id]);
    if (!a.rows[0]) throw new BadRequestException('申诉不存在');
    await this.db.query(
      `INSERT INTO appeal_evidence(appeal_id, source, title, content, media_url, captured_at, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        id,
        dto.source,
        dto.title,
        dto.content,
        dto.media_url ?? null,
        dto.captured_at ? new Date(dto.captured_at) : new Date(),
        user.sub,
      ],
    );
    const result = await this.buildAdjudication(this.db, a.rows[0]);
    return { adjudication: result };
  }

  // 物业接单处置：联系挪车 / 安排替代充电桩 / 免除预约费用（可多次叠加）
  @Roles('property', 'admin')
  @Post(':id/handle')
  async handle(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: HandleDto) {
    const allowed: HandleDto['action'][] = ['contact_move', 'alternative_charger', 'waive_fee'];
    if (!allowed.includes(dto.action)) throw new BadRequestException('处置动作非法');
    if (dto.action === 'alternative_charger' && !dto.alt_charger_code?.trim())
      throw new BadRequestException('安排替代充电桩需填写桩编号');

    return this.db.withTx(async (c) => {
      const aq = await c.query(`SELECT * FROM appeals WHERE id=$1 FOR UPDATE`, [id]);
      const appeal = aq.rows[0];
      if (!appeal) throw new BadRequestException('申诉不存在');
      if (appeal.appeal_type !== 'charging_occupy')
        throw new BadRequestException('该处置仅适用于充电车位错占申诉；普通工单请使用夜间调度看板派发挪车通知');

      const actions = Array.isArray(appeal.property_actions) ? appeal.property_actions : [];
      const record = {
        action: dto.action,
        alt_charger_code: dto.alt_charger_code ?? null,
        note: dto.note ?? null,
        by: user.sub,
        by_role: user.role,
        at: new Date().toISOString(),
      };
      actions.push(record);
      await c.query(
        `UPDATE appeals SET property_actions=$1::jsonb, handled_by=$2, handled_at=now(),
           alt_charger_code=COALESCE($3, alt_charger_code) WHERE id=$4`,
        [JSON.stringify(actions), user.sub, dto.alt_charger_code ?? null, id],
      );

      const detail = JSON.stringify({ ...record, appeal_id: appeal.id });
      if (dto.action === 'contact_move') {
        // 派发挪车通知（App 推送 + 车位 LED）
        const ticket = await this.upsertIceTicket(c, {
          spotId: appeal.spot_id,
          reservationId: appeal.reservation_id,
          plate: appeal.occupying_plate,
          description: dto.note ?? '物业接单：联系燃油车主挪车',
          detail: { appeal_id: appeal.id },
        });
        await c.query(
          `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
           VALUES ($1,$2,'app_push+led',$3, now())`,
          [
            ticket.id,
            appeal.occupying_plate ?? '未知车牌',
            `您的车辆占用了已预约充电车位（充电桩 ${appeal.charger_code}），请立即挪车；无有效预约将记录违约并影响后续预约权限与押金`,
          ],
        );
        await c.query(`UPDATE incident_tickets SET status='notified' WHERE id=$1`, [ticket.id]);
      }

      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
         VALUES ($1,$2,'charging_dispute_handled',$3,$4,$5,$6)`,
        [appeal.reservation_id, appeal.spot_id, user.sub, user.role, appeal.occupying_plate, detail],
      );
      return { ok: true, appeal: await this.loadAppeal(c, appeal.id) };
    });
  }

  // 物业/管理员终裁（可采纳自动建议或人工改判）
  @Roles('property', 'admin')
  @Post(':id/rule')
  async rule(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { ruling: AdjudicationResult['ruling']; note?: string },
  ) {
    const allowed = ['driver_fault', 'owner_fault', 'platform_fault', 'property_fault', 'stranger', 'mixed', 'no_fault'];
    if (!allowed.includes(body.ruling)) throw new BadRequestException('裁决类型非法');
    return this.db.withTx(async (c) => {
      const a = await c.query(`SELECT * FROM appeals WHERE id=$1 FOR UPDATE`, [id]);
      const appeal = a.rows[0];
      if (!appeal) throw new BadRequestException('申诉不存在');
      await c.query(
        `UPDATE appeals SET status='closed', ruling=$1, ruling_note=$2, ruled_by=$3, ruled_at=now() WHERE id=$4`,
        [body.ruling, body.note ?? null, user.sub, id],
      );

      // 充电位错占成立且占位燃油车无有效预约：登记违约（信用/押金/挂账追缴）
      let violation: any = null;
      if (
        appeal.appeal_type === 'charging_occupy' &&
        ['stranger', 'mixed'].includes(body.ruling) &&
        appeal.occupying_plate
      ) {
        violation = await this.recordViolation(c, appeal, user);
      }

      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,'appeal_ruled',$3,$4,$5)`,
        [
          appeal.reservation_id,
          appeal.spot_id,
          user.sub,
          user.role,
          JSON.stringify({ ruling: body.ruling, note: body.note, violation_id: violation?.id ?? null }),
        ],
      );
      return { ok: true, violation };
    });
  }

  // —— 登记燃油车占位违约：识别车主账号、扣信用、押金抵扣、不足挂账追缴 ——
  private async recordViolation(client: any, appeal: any, ruledBy: JwtUser) {
    const plate = normalizePlate(appeal.occupying_plate);
    const entry = await this.fetchOccupyingEntry(client, appeal.spot_id, plate, new Date(appeal.arrived_at));
    const hasValid = !!entry?.validReservation;
    const rule = VIOLATION_RULES.ice_occupy_charger;

    const ownerQ = await client.query(
      `SELECT u.id, u.name, u.credit_score, u.deposit_balance, u.outstanding_amount
       FROM vehicles v JOIN users u ON u.id=v.user_id
       WHERE REPLACE(REPLACE(UPPER(v.plate),' ',''),'-','')=$1
       ORDER BY u.id LIMIT 1`,
      [plate],
    );
    const owner = ownerQ.rows[0] ?? null;

    let fine = 0;
    let creditDelta = 0;
    let depositDeducted = 0;
    let outstanding = 0;
    if (!hasValid) {
      // 无有效预约：违约金 + 信用处罚 + 押金规则
      fine = rule.fine;
      creditDelta = rule.creditDelta;
      if (owner) {
        const applied = applyFineToDeposit({ fine, depositBalance: Number(owner.deposit_balance) });
        depositDeducted = applied.depositDeducted;
        outstanding = applied.outstanding;
        await client.query(
          `UPDATE users
             SET credit_score=GREATEST(0, credit_score + $2),
                 deposit_balance=$3,
                 outstanding_amount=outstanding_amount + $4
           WHERE id=$1`,
          [owner.id, creditDelta, applied.remainingDeposit, outstanding],
        );
        await client.query(
          `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
           VALUES ($1,$2,'violation_recorded',$3,'property',$4,$5)`,
          [
            appeal.reservation_id,
            appeal.spot_id,
            ruledBy.sub,
            plate,
            JSON.stringify({
              type: 'ice_occupy_charger',
              has_valid_reservation: false,
              fine,
              credit_delta: creditDelta,
              deposit_deducted: depositDeducted,
              outstanding,
              user_id: owner.id,
            }),
          ],
        );
      }
    }

    const ins = await client.query(
      `INSERT INTO violation_records(code, type, plate, user_id, spot_id, appeal_id, reservation_id,
         description, has_valid_reservation, fine, deposit_deducted, amount_outstanding, credit_delta,
         status, evidence, created_by)
       VALUES ($1,'ice_occupy_charger',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        'V' + Date.now().toString(36).toUpperCase(),
        plate,
        owner?.id ?? null,
        appeal.spot_id,
        appeal.id,
        appeal.reservation_id,
        `燃油车 ${plate} 占用带充电桩车位${hasValid ? '（系统存在预约记录，转人工核查）' : '且无有效预约'}`,
        hasValid,
        fine,
        depositDeducted,
        outstanding,
        creditDelta,
        hasValid ? 'waived' : owner ? 'deducted' : 'recorded',
        JSON.stringify({
          gate_entry: entry?.entry ?? null,
          charger_code: appeal.charger_code,
          arrived_at: appeal.arrived_at,
        }),
        ruledBy.sub,
      ],
    );
    return ins.rows[0];
  }

  /** 调取占用车辆道闸入场记录并核验其在该时段是否有有效预约 */
  async fetchOccupyingEntry(client: any, spotId: number, plate: string, arrivedAt: Date) {
    const windowStart = new Date(arrivedAt.getTime() - 3 * 3600000);
    const windowEnd = new Date(arrivedAt.getTime() + 30 * 60000);
    // gate_entry 识别放行 / manual_release 人工放行 / recognition_fail 识别失败（疑似跟车入场）
    const eq = await client.query(
      `SELECT type, occurred_at, gate, confidence, plate, detail
       FROM service_events
       WHERE type IN ('gate_entry','manual_release','recognition_fail') AND plate=$1
         AND occurred_at BETWEEN $2 AND $3
       ORDER BY occurred_at DESC LIMIT 1`,
      [plate, windowStart, windowEnd],
    );
    const entry = eq.rows[0]
      ? {
          type: eq.rows[0].type,
          occurred_at: eq.rows[0].occurred_at,
          gate: eq.rows[0].gate,
          confidence: eq.rows[0].confidence,
          mode_note: eq.rows[0].detail?.note ?? (eq.rows[0].type === 'recognition_fail' ? '道闸无匹配/低置信度，疑似跟车入场' : null),
        }
      : null;

    // 有效预约核验：同车牌在该车位、时间窗重叠且状态有效
    const rq = await client.query(
      `SELECT r.id, r.code, r.start_at, r.end_at, r.status, s.code AS spot_code
       FROM reservations r JOIN parking_spots s ON s.id=r.spot_id
       WHERE REPLACE(REPLACE(UPPER(r.plate),' ',''),'-','')=$1
         AND r.status IN ('reserved','admitted','in_garage')
         AND r.start_at < $3 AND r.end_at > $2
       ORDER BY r.start_at LIMIT 5`,
      [plate, windowStart, windowEnd],
    );
    const sameSpot = rq.rows.find((x: any) => Number(x.spot_id ?? spotId) === Number(spotId));
    return {
      entry,
      reservations: rq.rows,
      validReservation: sameSpot ?? null,
    };
  }

  private async upsertIceTicket(
    client: any,
    t: { spotId: number; reservationId: number | null; plate: string | null; description: string; detail: Record<string, any> },
  ) {
    const exist = await client.query(
      `SELECT id FROM incident_tickets
       WHERE type='ice_occupy_charger' AND status IN ('open','notified')
         AND spot_id=$1 AND (reservation_id=$2 OR ($2 IS NULL AND reservation_id IS NULL))
       ORDER BY id DESC LIMIT 1`,
      [t.spotId, t.reservationId],
    );
    if (exist.rows[0]) {
      return (await client.query(`SELECT * FROM incident_tickets WHERE id=$1`, [exist.rows[0].id])).rows[0];
    }
    const ins = await client.query(
      `INSERT INTO incident_tickets(code, spot_id, reservation_id, type, status, plate, reporter_role, description, detail)
       VALUES ($1,$2,$3,'ice_occupy_charger','open',$4,'driver',$5,$6) RETURNING *`,
      [
        'T' + Date.now().toString(36).toUpperCase(),
        t.spotId,
        t.reservationId,
        t.plate,
        t.description,
        JSON.stringify(t.detail),
      ],
    );
    return ins.rows[0];
  }

  private async loadAppeal(client: any, id: number) {
    return (await client.query(`SELECT * FROM appeals WHERE id=$1`, [id])).rows[0];
  }

  /** 汇总六类证据并执行自动裁决；系统证据（识别/道闸/巡查/业主回家）自动从事件流抽取 */
  async runAdjudication(client: any, appealId: number): Promise<AdjudicationResult> {
    const appealQ = await client.query(
      `SELECT a.*, r.plate AS reserved_plate, r.start_at, r.end_at, s.code AS spot_code
       FROM appeals a
       JOIN reservations r ON r.id=a.reservation_id
       JOIN parking_spots s ON s.id=a.spot_id
       WHERE a.id=$1`,
      [appealId],
    );
    const appeal = appealQ.rows[0];
    const result = await this.buildAdjudication(client, appeal);
    if (appeal.status === 'open') {
      await client.query(`UPDATE appeals SET status='investigating' WHERE id=$1`, [appealId]);
    }
    return result;
  }

  private async buildAdjudication(client: any, appeal: any): Promise<AdjudicationResult> {
    const reservationId = appeal.reservation_id;
    const stored = await client.query(
      `SELECT source, title, content, media_url, captured_at FROM appeal_evidence
       WHERE appeal_id=$1 ORDER BY captured_at NULLS LAST, id`,
      [appeal.id],
    );

    const evidence: EvidenceItem[] = stored.rows.map((e: any) => ({
      source: e.source,
      title: e.title,
      content: [e.title, e.content].filter(Boolean).join('：'),
      capturedAt: e.captured_at,
      stance: /支持|无责|陌生|识别失败|人工放行|信号|回家|燃油车/.test(`${e.title}${e.content}`) ? 'support' : 'neutral',
    }));

    // ---- 自动从同一笔停车服务的事件流抽取系统证据 ----
    const events = await client.query(
      `SELECT type, occurred_at, plate, gate, confidence, detail FROM service_events
       WHERE reservation_id=$1 ORDER BY occurred_at, id`,
      [reservationId],
    );
    const seen = new Set(evidence.map((e) => e.content));
    const push = (e: EvidenceItem) => {
      if (!seen.has(e.content)) evidence.push(e);
    };

    // 预约记录本身（中性：只证明预约存在，不指向责任）
    push({
      source: 'reservation',
      title: '预约记录',
      content: `预约车位 ${appeal.spot_code ?? appeal.spot_code}，车牌 ${appeal.reserved_plate ?? appeal.plate}，预约时段内有效`,
      capturedAt: appeal.start_at,
      stance: 'neutral',
    });

    let actualPlate: string | null = null;
    const incidents: AdjudicationInput2 = [];

    for (const ev of events.rows) {
      const d = ev.detail ?? {};
      switch (ev.type) {
        case 'gate_entry':
        case 'manual_release':
          push({
            source: 'gate_log',
            title: '道闸入场日志',
            content: `${ev.occurred_at.toISOString?.() ?? ev.occurred_at} ${ev.gate ?? ''} 道闸${ev.type === 'manual_release' ? '物业人工放行' : '识别放行'}，车牌 ${ev.plate}`,
            capturedAt: ev.occurred_at,
            stance: 'neutral',
            confidence: Number(ev.confidence ?? 0.9),
          });
          actualPlate = ev.plate;
          break;
        case 'recognition_fail':
          push({
            source: 'gate_log',
            title: '道闸识别失败记录',
            content: `道闸识别失败：${d.hint ?? '无匹配/低置信度'}，置信度 ${ev.confidence}`,
            capturedAt: ev.occurred_at,
            stance: 'support',
          });
          break;
        case 'wrong_parking_detected':
          push({
            source: 'plate_recognition',
            title: '停放核验',
            content: `预约车位 ${d.expected}，实际停放车位 ${d.actual}；识别车牌 ${ev.plate} 停在车位 ${d.actual}`,
            actualSpot: d.actual,
            expectedSpot: d.expected,
            capturedAt: ev.occurred_at,
            stance: 'refute',
            confidence: 0.9,
          });
          actualPlate = ev.plate;
          break;
        case 'parking_confirmed':
          push({
            source: 'plate_recognition',
            title: '车牌识别停放确认',
            content: `车牌 ${ev.plate} 正常停在预约车位 ${appeal.spot_code ?? ''}`,
            capturedAt: ev.occurred_at,
            stance: 'support',
            confidence: 0.9,
          });
          actualPlate = ev.plate;
          break;
        case 'owner_return_report':
          push({
            source: 'owner_home',
            title: '业主回家时间',
            content: `业主在共享时段内临时回家（${d.eta_minutes ?? 30} 分钟后到达）`,
            capturedAt: ev.occurred_at,
            stance: 'support',
          });
          incidents.push({ type: 'owner_return', started_at: ev.occurred_at });
          break;
        case 'weak_signal_report':
          push({
            source: 'signal',
            title: '地下车库信号差上报',
            content: `区域 ${d.area ?? 'B2'} 信号差，使用离线导航`,
            capturedAt: ev.occurred_at,
            stance: 'support',
          });
          incidents.push({ type: 'weak_signal' });
          break;
        case 'charging_occupy_report':
          incidents.push({ type: 'ice_occupy_charger', started_at: ev.occurred_at });
          push({
            source: 'patrol',
            title: '充电位错占上报',
            content: `燃油车 ${ev.plate} 占用充电桩 ${d.charger_code}，到达时间 ${d.arrived_at}，${d.has_valid_reservation ? '系统存在预约记录' : '无有效预约'}`,
            capturedAt: ev.occurred_at,
            stance: 'support',
          });
          break;
      }
    }

    // 关联异常工单（如夜巡在申诉前已登记的燃油车占位工单）
    const ticketQ = await client.query(
      `SELECT type, created_at, resolved_at, plate, description FROM incident_tickets
       WHERE reservation_id=$1 ORDER BY created_at`,
      [reservationId],
    );
    for (const t of ticketQ.rows) {
      incidents.push({ type: t.type, started_at: t.created_at, resolved_at: t.resolved_at });
      if (t.type === 'ice_occupy_charger') {
        push({
          source: 'patrol',
          title: '夜间调度工单（燃油车占充电位）',
          content: `工单记录燃油车 ${t.plate ?? ''} 占用充电车位：${t.description ?? ''}`,
          capturedAt: t.created_at,
          stance: 'support',
        });
      }
    }

    // 巡查记录
    const patrols = await client.query(
      `SELECT p.note, p.plate, p.media_url, p.patrolled_at FROM patrol_logs p
       WHERE p.spot_id=$1 AND p.patrolled_at BETWEEN $2 AND $3
       ORDER BY p.patrolled_at`,
      [appeal.spot_id, appeal.start_at, appeal.end_at],
    );
    for (const p of patrols.rows) {
      push({
        source: 'patrol',
        title: '物业巡查记录',
        content: p.note + (p.media_url ? `（现场照片 ${p.media_url}）` : ''),
        capturedAt: p.patrolled_at,
        stance: /normal/.test(p.note) ? 'support' : 'neutral',
      });
      if (/stranger|ice_on_charger/.test(p.note)) actualPlate = p.plate ?? actualPlate;
    }

    // 充电位错占：实际占用车辆为燃油车车牌
    if (appeal.appeal_type === 'charging_occupy' && appeal.occupying_plate) {
      actualPlate = appeal.occupying_plate;
    }

    return adjudicateAppeal({
      reservedSpotCode: appeal.spot_code,
      reservedPlate: appeal.reserved_plate ?? appeal.plate,
      actualPlate,
      evidence,
      incidents,
      reservationStart: appeal.start_at,
      reservationEnd: appeal.end_at,
    });
  }
}

type AdjudicationInput2 = Array<{ type: string; started_at?: Date | null; resolved_at?: Date | null }>;

function normalizePlate(p: string) {
  return (p || '').replace(/[^0-9A-Z一-龥]/gi, '').toUpperCase();
}
