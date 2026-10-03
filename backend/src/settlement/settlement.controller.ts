import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';
import { Ruling, settlePrice, SettlementBreakdown } from '../domain/pricing';
import { buildSpotTimeline, TimelineIncident, TimelineOrder } from '../domain/timeline';
import { calcRechargeCompensation } from '../domain/recharge';

class ExitDto {
  charge_kwh?: number;
  exit_at?: string; // 道闸时钟/离场补录时间
}

@Controller()
@UseGuards(AuthGuard)
export class SettlementController {
  constructor(private db: DbService) {}

  // 离场结算：把计费规则、异常、申诉裁决合并清算
  @Post('reservations/:id/exit')
  async exit(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: ExitDto) {
    return this.db.withTx(async (c) => {
      const rq = await c.query(
        `SELECT r.*, s.hourly_rate, s.overnight_cap, s.near_charger, s.owner_id,
                v.is_new_energy, v.plate AS vplate
         FROM reservations r
         JOIN parking_spots s ON s.id=r.spot_id
         JOIN vehicles v ON v.id=r.vehicle_id
         WHERE r.id=$1 FOR UPDATE`,
        [id],
      );
      const r = rq.rows[0];
      if (!r) throw new BadRequestException('预约不存在');
      if (['completed', 'cancelled'].includes(r.status)) throw new BadRequestException('订单已结束');

      const exitAt = dto.exit_at ? new Date(dto.exit_at) : new Date();
      await c.query(
        `UPDATE reservations SET status='completed',
           gate_exit_at=COALESCE($2::timestamptz, gate_exit_at, now()) WHERE id=$1`,
        [id, exitAt],
      );

      const breakdown = await this.computeBreakdown(c, r, exitAt, dto.charge_kwh ?? 0);
      const settlement = await this.persistSettlement(c, r, exitAt, breakdown);

      // 持久化充电会话（补电补偿重算时以实际充电量为准）
      if (dto.charge_kwh && dto.charge_kwh > 0) {
        await c.query(
          `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
           VALUES ($1,$2,'charging_session',$3,$4,$5,$6)`,
          [id, r.spot_id, user.sub, user.role, r.plate, JSON.stringify({ kwh: dto.charge_kwh })],
        );
      }

      // 信用分
      if (breakdown.creditTarget !== 'none' && breakdown.creditDelta !== 0) {
        const targetId =
          breakdown.creditTarget === 'owner'
            ? r.owner_id
            : breakdown.creditTarget === 'property'
              ? null
              : r.driver_id;
        if (targetId) {
          await c.query(`UPDATE users SET credit_score=GREATEST(0, credit_score + $1) WHERE id=$2`, [
            breakdown.creditDelta,
            targetId,
          ]);
        }
        await c.query(
          `INSERT INTO service_events(reservation_id, spot_id, type, actor_role, detail)
           VALUES ($1,$2,'credit_adjusted',$3,$4)`,
          [
            id,
            r.spot_id,
            user.role,
            JSON.stringify({ target: breakdown.creditTarget, delta: breakdown.creditDelta }),
          ],
        );
      }

      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
         VALUES ($1,$2,'settlement_completed',$3,$4,$5,$6)`,
        [
          id,
          r.spot_id,
          user.sub,
          user.role,
          r.plate,
          JSON.stringify({ payable: breakdown.payable, refund: breakdown.refund, exit_charge: breakdown.exitCharge }),
        ],
      );

      return settlement;
    });
  }

  // 仅试算（离场前预览账单）
  @Get('reservations/:id/quote')
  async quote(@CurrentUser() user: JwtUser, @Param('id') id: string, @Query('charge_kwh') kwh?: string) {
    const rq = await this.db.query(
      `SELECT r.*, s.hourly_rate, s.overnight_cap, s.near_charger, s.owner_id, v.is_new_energy
       FROM reservations r
       JOIN parking_spots s ON s.id=r.spot_id
       JOIN vehicles v ON v.id=r.vehicle_id
       WHERE r.id=$1`,
      [id],
    );
    const r = rq.rows[0];
    if (!r) throw new BadRequestException('预约不存在');
    return this.computeBreakdown(this.db, r, new Date(), Number(kwh ?? 0));
  }

  @Get('reservations/:id/settlement')
  async settlement(@Param('id') id: string) {
    const sq = await this.db.query(`SELECT * FROM settlements WHERE reservation_id=$1`, [id]);
    if (!sq.rows[0]) return null;
    const ledger = await this.db.query(`SELECT * FROM ledger_entries WHERE settlement_id=$1 ORDER BY id`, [sq.rows[0].id]);
    return { ...sq.rows[0], ledger: ledger.rows };
  }

  // 申诉终裁后重算分账（物业/管理员）
  @Roles('property', 'admin')
  @Post('appeals/:id/resettle')
  async resettle(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.db.withTx(async (c) => {
      const aq = await c.query(
        `SELECT * FROM appeals WHERE id=$1 AND status='closed'`,
        [id],
      );
      const appeal = aq.rows[0];
      if (!appeal) throw new BadRequestException('申诉未终裁，不能重算');
      const rq = await c.query(
        `SELECT r.*, s.hourly_rate, s.overnight_cap, s.near_charger, s.owner_id, v.is_new_energy
         FROM reservations r
         JOIN parking_spots s ON s.id=r.spot_id
         JOIN vehicles v ON v.id=r.vehicle_id
         WHERE r.id=$1 FOR UPDATE`,
        [appeal.reservation_id],
      );
      const r = rq.rows[0];
      const old = await c.query(`SELECT * FROM settlements WHERE reservation_id=$1`, [r.id]);
      // 重算前反向冲销旧结算对信用分的影响（仅系统内账号：车主/业主）
      if (old.rows[0] && old.rows[0].credit_delta !== 0 && ['driver', 'owner'].includes(old.rows[0].credit_target)) {
        const oldTargetId = old.rows[0].credit_target === 'owner' ? r.owner_id : r.driver_id;
        await c.query(
          `UPDATE users SET credit_score=GREATEST(0, credit_score - $1) WHERE id=$2`,
          [old.rows[0].credit_delta, oldTargetId],
        );
      }
      if (old.rows[0]) await c.query(`DELETE FROM settlements WHERE id=$1`, [old.rows[0].id]);

      const breakdown = await this.computeBreakdown(c, r, r.gate_exit_at ?? new Date(), 0, appeal.ruling, appeal.id);
      const settlement = await this.persistSettlement(c, r, r.gate_exit_at ?? new Date(), breakdown, appeal.id, appeal.ruling);

      // 终裁后信用分修正：先回滚旧的影响再施加新的（简化：直接按差值调整）
      if (breakdown.creditDelta !== 0) {
        const targetId = breakdown.creditTarget === 'owner' ? r.owner_id : r.driver_id;
        await c.query(`UPDATE users SET credit_score=GREATEST(0, credit_score + $1) WHERE id=$2`, [
          breakdown.creditDelta,
          targetId,
        ]);
      }
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,'settlement_recomputed',$3,$4,$5)`,
        [r.id, r.spot_id, user.sub, user.role, JSON.stringify({ appeal_id: id, ruling: appeal.ruling })],
      );
      return settlement;
    });
  }

  // 分账流水总览（物业/管理员/业主看自己车位）
  @Get('ledger')
  async ledger(
    @CurrentUser() user: JwtUser,
    @Query('account') account?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const params: any[] = [];
    let where = '1=1';
    if (account) {
      params.push(account);
      where += ` AND l.account=$${params.length}`;
    }
    if (from) {
      params.push(new Date(from));
      where += ` AND l.created_at >= $${params.length}`;
    }
    if (to) {
      params.push(new Date(to));
      where += ` AND l.created_at <= $${params.length}`;
    }
    if (user.role === 'owner') {
      params.push(user.sub);
      where += ` AND s.spot_id IN (SELECT id FROM parking_spots WHERE owner_id=$${params.length})`;
    }
    return this.db
      .query(
        `SELECT l.*, st.code AS settlement_code, r.code AS reservation_code, r.spot_id, sp.code AS spot_code
         FROM ledger_entries l
         JOIN settlements st ON st.id=l.settlement_id
         JOIN reservations r ON r.id=st.reservation_id
         JOIN parking_spots sp ON sp.id=st.spot_id
         WHERE ${where}
         ORDER BY l.id DESC LIMIT 300`,
        params,
      )
      .then((q) => q.rows);
  }

  // ---- 单车位一晚时间轴：解释每段时间谁使用/谁付款/谁违约 ----
  @Get('spots/:id/timeline')
  async timeline(
    @Param('id') id: string,
    @Query('date') date?: string, // YYYY-MM-DD（当晚起点，默认今晚）
    @Query('start') startQ?: string, // 审计任意时间窗（优先于 date）
    @Query('end') endQ?: string,
  ) {
    const spot = await this.db.query(`SELECT * FROM parking_spots WHERE id=$1`, [id]);
    if (!spot.rows[0]) throw new BadRequestException('车位不存在');

    // 默认"今晚"：当天 18:00 到次日 09:00；也可用 start/end 指定任意审计窗口
    let nightStart: Date;
    let nightEnd: Date;
    if (startQ && endQ) {
      nightStart = new Date(startQ);
      nightEnd = new Date(endQ);
    } else {
      const base = date ? new Date(`${date}T18:00:00`) : (() => {
        const d = new Date();
        d.setHours(18, 0, 0, 0);
        return d;
      })();
      nightStart = base;
      nightEnd = new Date(base.getTime() + 15 * 3600000);
    }

    const oq = await this.db.query(
      `SELECT r.id, r.code, u.name AS driver_name, r.plate, r.status, r.start_at, r.end_at,
              r.gate_entry_at, r.parking_confirmed_at, r.gate_exit_at,
              st.ruling, st.base_fee, st.overtime_fee, st.wrong_park_fine,
              st.abnormal_compensation, st.payable,
              (SELECT MIN(occurred_at) FROM service_events e
                WHERE e.reservation_id=r.id AND e.type IN ('parking_confirmed','gate_entry')) AS dummy
       FROM reservations r
       JOIN users u ON u.id=r.driver_id
       LEFT JOIN settlements st ON st.reservation_id=r.id
       WHERE r.spot_id=$1 AND r.start_at < $2 AND r.end_at > $3
       ORDER BY r.start_at`,
      [id, nightEnd, nightStart],
    );

    // usable_from：识别成功/可使用时间点（被陌生车占用则以占用解除时间为准，简化用停车确认时间）
    const orders: TimelineOrder[] = oq.rows.map((o: any) => ({
      id: o.id,
      code: o.code,
      driverName: o.driver_name,
      plate: o.plate,
      status: o.status,
      reservedStart: o.start_at,
      reservedEnd: o.end_at,
      gateEntryAt: o.gate_entry_at,
      parkingConfirmedAt: o.parking_confirmed_at,
      gateExitAt: o.gate_exit_at,
      usableFrom: o.parking_confirmed_at ?? o.gate_entry_at,
      settlement: o.ruling || o.base_fee != null
        ? {
            ruling: o.ruling,
            baseFee: Number(o.base_fee ?? 0),
            overtimeFee: Number(o.overtime_fee ?? 0),
            wrongParkFine: Number(o.wrong_park_fine ?? 0),
            abnormalCompensation: Number(o.abnormal_compensation ?? 0),
            payable: Number(o.payable ?? 0),
          }
        : null,
    }));

    const iq = await this.db.query(
      `SELECT id, type, status, plate, created_at, resolved_at, resolution, reservation_id
       FROM incident_tickets
       WHERE spot_id=$1 AND created_at < $2 AND (resolved_at IS NULL OR resolved_at > $3)
       ORDER BY created_at`,
      [id, nightEnd, nightStart],
    );
    const incidents: TimelineIncident[] = iq.rows.map((i: any) => ({
      id: i.id,
      type: i.type,
      status: i.status,
      plate: i.plate,
      createdAt: i.created_at,
      resolvedAt: i.resolved_at,
      resolution: i.resolution,
      reservationId: i.reservation_id,
    }));

    const segments = buildSpotTimeline(nightStart, nightEnd, orders, incidents);
    return {
      spot: { id: spot.rows[0].id, code: spot.rows[0].code },
      night_start: nightStart,
      night_end: nightEnd,
      orders,
      incidents,
      segments,
    };
  }

  // ---- 核心：组装分账输入 ----
  private async computeBreakdown(
    client: any,
    r: any,
    exitAt: Date,
    chargeKwh: number,
    forcedRuling?: Ruling | null,
    appealId?: number,
  ): Promise<SettlementBreakdown> {
    // 该笔服务关联的异常
    const iq = await client.query(
      `SELECT type, created_at, resolved_at, detail FROM incident_tickets
       WHERE reservation_id=$1 ORDER BY created_at`,
      [r.id],
    );
    const incidents = iq.rows.map((i: any) => ({
      type: i.type,
      started_at: i.created_at,
      resolved_at: i.resolved_at,
      detail: i.detail ?? {},
    }));

    // 申诉裁决（优先使用传入的终裁，其次取已关闭申诉）
    let ruling: Ruling | null = forcedRuling ?? null;
    if (!ruling) {
      const aq = await client.query(
        `SELECT ruling FROM appeals WHERE reservation_id=$1 AND status='closed' ORDER BY ruled_at DESC NULLS LAST LIMIT 1`,
        [r.id],
      );
      ruling = aq.rows[0]?.ruling ?? null;
    }

    // 优惠券抵扣（预约时已核销，这里从 coupon 关联反查）
    const cq = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS amount FROM coupons WHERE used_reservation_id=$1`,
      [r.id],
    );
    const couponAmount = Number(cq.rows[0].amount);

    // usable_from：若存在陌生车占用，为占用解除时间；否则入场/停车确认时间
    let usableFrom = r.parking_confirmed_at ?? r.gate_entry_at ?? r.start_at;
    const stranger = iq.rows.find((i: any) => ['stranger_occupy', 'ice_occupy_charger'].includes(i.type));
    if (stranger?.resolved_at && new Date(stranger.resolved_at) > new Date(usableFrom)) {
      usableFrom = stranger.resolved_at;
    }

    // 充电量结算优先使用已持久化的值（重算场景）
    let kwh = chargeKwh;
    if (!kwh) {
      const detail = await client.query(
        `SELECT detail FROM service_events WHERE reservation_id=$1 AND type='charging_session' ORDER BY id DESC LIMIT 1`,
        [r.id],
      );
      kwh = Number(detail.rows[0]?.detail?.kwh ?? 0);
    }

    // 充电位错占申诉：物业"免除预约费"动作 + 按实际充电量重算的补电补偿
    let waiveReservationFee = false;
    let rechargeCompensation = 0;
    let rechargeKwhGap = 0;
    const chargeAppealQ = await client.query(
      `SELECT id, property_actions, requested_kwh, actual_kwh, recharge_compensation
       FROM appeals WHERE reservation_id=$1 AND appeal_type='charging_occupy'
       ORDER BY id DESC LIMIT 1`,
      [r.id],
    );
    const chargeAppeal = chargeAppealQ.rows[0];
    if (chargeAppeal) {
      const actions: any[] = Array.isArray(chargeAppeal.property_actions) ? chargeAppeal.property_actions : [];
      waiveReservationFee = actions.some((a) => a.action === 'waive_fee');
      // 替代充电桩安排后，实际充入电量提升；以实际充电会话 kwh 重算未充满缺口
      const recharge = calcRechargeCompensation({
        requestedKwh: Number(chargeAppeal.requested_kwh ?? 0),
        actualKwh: kwh,
      });
      rechargeCompensation = recharge.compensation;
      rechargeKwhGap = recharge.kwhGap;
      await client.query(
        `UPDATE appeals SET actual_kwh=$2, recharge_compensation=$3 WHERE id=$1`,
        [chargeAppeal.id, kwh, rechargeCompensation],
      );
    }

    return settlePrice({
      reservedStart: r.start_at,
      reservedEnd: r.end_at,
      actualEntry: r.gate_entry_at ?? r.start_at,
      actualExit: exitAt,
      usableFrom,
      hourlyRate: Number(r.hourly_rate),
      overnightCap: r.overnight_cap != null ? Number(r.overnight_cap) : null,
      isNewEnergy: r.is_new_energy,
      chargeKwh: kwh,
      incidents,
      ruling,
      couponAmount,
      prepaid: Number(r.estimated_fee && couponAmount ? Math.max(0, Number(r.estimated_fee) - couponAmount) : (r.estimated_fee ?? 0)),
      waiveReservationFee,
      rechargeCompensation,
      rechargeKwhGap,
    });
  }

  private async persistSettlement(
    c: any,
    r: any,
    exitAt: Date,
    b: SettlementBreakdown,
    appealId?: number,
    ruling?: Ruling | null,
  ) {
    const code = 'ST' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
    const ins = await c.query(
      `INSERT INTO settlements(code, reservation_id, spot_id, actual_entry_at, actual_exit_at, usable_from,
         duration_minutes, base_fee, charging_fee, overtime_fee, wrong_park_fine,
         coupon_discount, abnormal_compensation, coupon_compensation, owner_compensation, prepaid, refund, exit_charge, payable,
         owner_income, property_fee, platform_fee, owner_share, property_share, platform_share,
         credit_target, credit_delta, appeal_id, ruling, recharge_compensation, recharge_kwh_gap, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
       RETURNING *`,
      [
        code, r.id, r.spot_id, b.actualEntryAt, b.actualExitAt, b.usableFrom,
        b.durationMinutes, b.baseFee, b.chargingFee, b.overtimeFee, b.wrongParkFine,
        b.couponDiscount, b.abnormalCompensation, b.couponCompensation, b.ownerCompensation, b.prepaid, b.refund, b.exitCharge, b.payable,
        b.ownerIncome, b.propertyFee, b.platformFee, b.ownerShare, b.propertyShare, b.platformShare,
        b.creditTarget, b.creditDelta, appealId ?? null, ruling ?? b.ruling,
        b.rechargeCompensation, b.rechargeKwhGap,
        JSON.stringify({ notes: b.notes }),
      ],
    );
    const settlement = ins.rows[0];
    await c.query(`UPDATE reservations SET settled_at=now(), settlement_id=$1 WHERE id=$2`, [
      settlement.id,
      r.id,
    ]);
    for (const e of b.ledger) {
      await c.query(
        `INSERT INTO ledger_entries(settlement_id, account, direction, amount, memo)
         VALUES ($1,$2,$3,$4,$5)`,
        [settlement.id, e.account === 'owner' ? `owner:${r.owner_id}` : e.account, e.direction, e.amount, e.memo],
      );
    }
    const ledger = await c.query(`SELECT * FROM ledger_entries WHERE settlement_id=$1 ORDER BY id`, [settlement.id]);
    return { ...settlement, ledger: ledger.rows, notes: b.notes };
  }
}
