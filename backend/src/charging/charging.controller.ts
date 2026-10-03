import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';
import { buildViolationPenalty } from '../domain/charging';

function normPlate(p?: string | null) {
  return (p || '').replace(/[^0-9A-Z一-龥]/gi, '').toUpperCase();
}

/**
 * 充电车位错占专项：
 *  - 车主押金钱包（充值 / 流水 / 生效违约）
 *  - 物业处置（联系挪车 / 安排替代充电桩 / 免除预约费用）
 *  - 终裁后对无有效预约的燃油车执行违约：违约金、押金没收、挂账追缴、信用与预约权限
 */
@Controller()
@UseGuards(AuthGuard)
export class ChargingController {
  constructor(private db: DbService) {}

  // ---- 押金钱包 ----
  @Roles('driver')
  @Post('wallet/deposit/topup')
  async topup(@CurrentUser() user: JwtUser, @Body() body: { amount: number }) {
    const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
    if (!(amount > 0)) throw new BadRequestException('充值金额必须大于 0');
    return this.db.withTx(async (c) => {
      await c.query(`UPDATE users SET deposit_balance=deposit_balance+$1 WHERE id=$2`, [amount, user.sub]);
      const ins = await c.query(
        `INSERT INTO deposit_transactions(user_id, direction, amount, memo)
         VALUES ($1,'topup',$2,'押金充值') RETURNING *`,
        [user.sub, amount],
      );
      const u = await c.query(`SELECT deposit_balance FROM users WHERE id=$1`, [user.sub]);
      return { tx: ins.rows[0], deposit_balance: Number(u.rows[0].deposit_balance) };
    });
  }

  // 补缴挂账追缴（违约后押金不足，车主补足后恢复预约权限）
  @Roles('driver')
  @Post('violations/:id/repay')
  async repay(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() body: { amount?: number }) {
    return this.db.withTx(async (c) => {
      const vq = await c.query(`SELECT * FROM violation_records WHERE id=$1 FOR UPDATE`, [id]);
      const v = vq.rows[0];
      if (!v) throw new BadRequestException('违约记录不存在');
      if (v.user_id !== user.sub) throw new BadRequestException('只能补缴本人名下的违约挂账');
      const amount = Math.round((Number(body.amount) > 0 ? Number(body.amount) : Number(v.receivable)) * 100) / 100;
      if (!(amount > 0) || Number(v.receivable) <= 0) throw new BadRequestException('该记录没有待补缴的挂账金额');
      const pay = Math.min(amount, Number(v.receivable));
      // 补缴属于违约金追缴（资金归平台冲抵垫付），不计入可退押金余额
      await c.query(
        `INSERT INTO deposit_transactions(user_id, direction, amount, violation_id, memo)
         VALUES ($1,'repay',$2,$3,'违约挂账追缴补缴（归平台冲抵先行垫付，不计入押金余额）') RETURNING *`,
        [user.sub, pay, v.id],
      );
      await c.query(
        `UPDATE violation_records SET receivable=receivable-$1, deposit_deducted=deposit_deducted+$1,
           status=CASE WHEN receivable-$1<=0 THEN 'closed' ELSE 'pending_recovery' END,
           booking_restriction=CASE WHEN receivable-$1<=0 THEN 'none' ELSE booking_restriction END
         WHERE id=$2`,
        [pay, v.id],
      );
      const u = await c.query(`SELECT deposit_balance FROM users WHERE id=$1`, [user.sub]);
      return { repaid: pay, deposit_balance: Number(u.rows[0].deposit_balance) };
    });
  }

  // 我的钱包：押金余额、流水、生效违约
  @Roles('driver')
  @Get('wallet')
  async wallet(@CurrentUser() user: JwtUser) {
    const u = await this.db.query(`SELECT deposit_balance, credit_score FROM users WHERE id=$1`, [user.sub]);
    const txs = await this.db.query(
      `SELECT * FROM deposit_transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 100`,
      [user.sub],
    );
    const violations = await this.db.query(
      `SELECT * FROM violation_records WHERE user_id=$1 ORDER BY id DESC LIMIT 50`,
      [user.sub],
    );
    const active = violations.rows
      .map((v: any) => ({ ...v, restriction_active: this.isRestrictionActive(v) }))
      .filter((v: any) => v.restriction_active);
    return {
      deposit_balance: Number(u.rows[0]?.deposit_balance ?? 0),
      credit_score: Number(u.rows[0]?.credit_score ?? 100),
      transactions: txs.rows,
      violations: violations.rows,
      active_restrictions: active,
    };
  }

  // 违约记录查询（管理员/物业全量，车主仅本人）
  @Get('violations')
  async listViolations(@CurrentUser() user: JwtUser, @Query('plate') plate?: string, @Query('status') status?: string) {
    const params: any[] = [];
    const conds: string[] = [];
    if (user.role === 'driver') {
      params.push(user.sub);
      conds.push(`v.user_id=$${params.length}`);
    }
    if (plate) {
      params.push(normPlate(plate));
      conds.push(`REPLACE(REPLACE(UPPER(v.plate),' ',''),'-','')=$${params.length}`);
    }
    if (status) {
      params.push(status);
      conds.push(`v.status=$${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.db
      .query(
        `SELECT v.*, u.name AS user_name, u.deposit_balance, s.code AS spot_code, a.code AS appeal_code
         FROM violation_records v
         LEFT JOIN users u ON u.id=v.user_id
         LEFT JOIN parking_spots s ON s.id=v.spot_id
         LEFT JOIN appeals a ON a.id=v.appeal_id
         ${where} ORDER BY v.id DESC LIMIT 200`,
        params,
      )
      .then((r) => r.rows);
  }

  // ---- 物业处置充电位错占：联系挪车 / 安排替代充电桩 / 免除预约费用 ----
  @Roles('property', 'admin')
  @Post('appeals/:id/disposition')
  async disposition(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { disposition: 'move_notice' | 'alternate_charger' | 'waive_fee'; note?: string; alternate_spot_id?: number },
  ) {
    if (!['move_notice', 'alternate_charger', 'waive_fee'].includes(body.disposition))
      throw new BadRequestException('处置方式非法');
    return this.db.withTx(async (c) => {
      const aq = await c.query(
        `SELECT a.*, r.plate AS reserved_plate FROM appeals a
         JOIN reservations r ON r.id=a.reservation_id WHERE a.id=$1 FOR UPDATE`,
        [id],
      );
      const a = aq.rows[0];
      if (!a) throw new BadRequestException('申诉不存在');
      await c.query(
        `UPDATE appeals SET disposition=$1, disposition_note=$2, handled_by=$3, handled_at=now() WHERE id=$4`,
        [body.disposition, body.note ?? null, user.sub, id],
      );

      // 关联的燃油车占充电位工单
      const ticketQ = await c.query(
        `SELECT * FROM incident_tickets WHERE reservation_id=$1 AND type='ice_occupy_charger'
           AND status IN ('open','notified') ORDER BY id DESC LIMIT 1`,
        [a.reservation_id],
      );
      const ticket = ticketQ.rows[0];
      const targetPlate = a.occupier_plate ?? ticket?.plate ?? null;

      if (body.disposition === 'move_notice' && ticket) {
        await c.query(
          `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
           VALUES ($1,$2,'app_push+led',$3, now())`,
          [ticket.id, targetPlate ?? '占用车辆', '您的燃油车占用了新能源预约充电位，请立即挪车，逾期将记录违约并影响预约权限与押金'],
        );
        await c.query(`UPDATE incident_tickets SET status='notified' WHERE id=$1`, [ticket.id]);
      }
      if (body.disposition === 'alternate_charger') {
        const altSpot = body.alternate_spot_id
          ? (await c.query(`SELECT code FROM parking_spots WHERE id=$1`, [body.alternate_spot_id])).rows[0]
          : null;
        if (ticket) {
          await c.query(
            `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
             VALUES ($1,$2,'app_push',$3, now())`,
            [ticket.id, a.reserved_plate, `已为您安排替代充电桩${altSpot ? ' ' + altSpot.code : ''}，到场可继续充电，绕行交通补偿已记录`],
          );
          await c.query(`UPDATE incident_tickets SET status='notified' WHERE id=$1`, [ticket.id]);
        }
      }
      if (body.disposition === 'waive_fee' && ticket) {
        await c.query(`UPDATE incident_tickets SET status='notified' WHERE id=$1`, [ticket.id]);
      }

      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,'ice_disposition',$3,'property',$4)`,
        [
          a.reservation_id,
          a.spot_id,
          user.sub,
          JSON.stringify({
            disposition: body.disposition,
            note: body.note,
            alternate_spot_id: body.alternate_spot_id ?? null,
            occupier_plate: targetPlate,
          }),
        ],
      );
      return { ok: true, disposition: body.disposition, target_plate: targetPlate };
    });
  }

  // ---- 终裁后执行燃油车违约（仅陌生车主责任 + 充电位错占）----
  @Roles('property', 'admin')
  @Post('appeals/:id/enforce-violation')
  async enforceViolation(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.db.withTx(async (c) => {
      const aq = await c.query(
        `SELECT a.*, r.plate AS reserved_plate, r.spot_id AS reservation_spot
         FROM appeals a JOIN reservations r ON r.id=a.reservation_id
         WHERE a.id=$1 FOR UPDATE`,
        [id],
      );
      const a = aq.rows[0];
      if (!a) throw new BadRequestException('申诉不存在');
      if (a.appeal_type !== 'ice_charger') throw new BadRequestException('仅充电位错占申诉可执行燃油车违约');
      if (a.status !== 'closed' || a.ruling !== 'stranger')
        throw new BadRequestException('申诉须终裁为"陌生车主责任"后才能执行违约');

      const existed = await c.query(`SELECT id FROM violation_records WHERE appeal_id=$1`, [id]);
      if (existed.rows[0]) throw new BadRequestException('该申诉已生成违约记录，请勿重复执行');

      // 占用车牌：以申诉登记/裁决证据为准
      let occupierPlate = a.occupier_plate;
      if (!occupierPlate) {
        const g = await c.query(
          `SELECT content FROM appeal_evidence WHERE appeal_id=$1 AND source='gate_access' LIMIT 1`,
          [id],
        );
        occupierPlate = g.rows[0]?.content?.match(/[一-龥][A-Z][A-Z0-9]{4,6}/)?.[0] ?? null;
      }
      if (!occupierPlate) throw new BadRequestException('未能确定占用车辆车牌，无法执行违约');

      // 是否持有有效预约
      const norm = normPlate(occupierPlate);
      const resQ = await c.query(
        `SELECT 1 FROM reservations
         WHERE REPLACE(REPLACE(UPPER(plate),' ',''),'-','')=$1 AND spot_id=$2
           AND status IN ('reserved','admitted','in_garage') LIMIT 1`,
        [norm, a.spot_id],
      );
      const hasReservation = resQ.rows.length > 0;

      // 定位平台账号（车牌档案）
      const ownerQ = await c.query(
        `SELECT u.id, u.credit_score, u.deposit_balance FROM vehicles v
         JOIN users u ON u.id=v.user_id
         WHERE REPLACE(REPLACE(UPPER(v.plate),' ',''),'-','')=$1
         ORDER BY v.id DESC LIMIT 1`,
        [norm],
      );
      const owner = ownerQ.rows[0] ?? null;

      const priorQ = await c.query(
        `SELECT COUNT(*)::int AS n FROM violation_records
         WHERE REPLACE(REPLACE(UPPER(plate),' ',''),'-','')=$1 AND type='ice_occupy_charger'`,
        [norm],
      );
      const penalty = buildViolationPenalty({
        creditScore: owner ? Number(owner.credit_score) : 100,
        priorViolationCount: priorQ.rows[0].n,
        depositBalance: owner ? Number(owner.deposit_balance) : 0,
        hasValidReservation: hasReservation,
      });

      if (penalty.fine === 0) {
        return { ok: true, skipped: true, reasons: penalty.reasons };
      }

      const ins = await c.query(
        `INSERT INTO violation_records(code, user_id, plate, type, reservation_id, appeal_id, spot_id,
           fine, deposit_deducted, receivable, credit_delta, booking_restriction, restriction_days,
           status, note, created_by)
         VALUES ($1,$2,$3,'ice_occupy_charger',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [
          'V' + Date.now().toString(36).toUpperCase(),
          owner?.id ?? null,
          occupierPlate,
          a.reservation_id,
          a.id,
          a.spot_id,
          penalty.fine,
          penalty.depositDeducted,
          penalty.receivable,
          penalty.creditDelta,
          penalty.restriction,
          penalty.restrictionDays,
          penalty.receivable > 0 ? 'pending_recovery' : 'enforced',
          penalty.reasons.join('；'),
          user.sub,
        ],
      );
      const violation = ins.rows[0];

      if (owner) {
        // 押金没收
        if (penalty.depositDeducted > 0) {
          await c.query(`UPDATE users SET deposit_balance=deposit_balance-$1 WHERE id=$2`, [
            penalty.depositDeducted,
            owner.id,
          ]);
          await c.query(
            `INSERT INTO deposit_transactions(user_id, direction, amount, violation_id, memo)
             VALUES ($1,'deduct',$2,$3,'燃油车占用充电位违约：押金没收，冲抵平台补电补偿垫付')`,
            [owner.id, penalty.depositDeducted, violation.id],
          );
        }
        // 信用扣减
        await c.query(`UPDATE users SET credit_score=GREATEST(0, credit_score+$1) WHERE id=$2`, [
          penalty.creditDelta,
          owner.id,
        ]);
      }

      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
         VALUES ($1,$2,'violation_enforced',$3,'property',$4,$5)`,
        [
          a.reservation_id,
          a.spot_id,
          user.sub,
          occupierPlate,
          JSON.stringify({
            violation_id: violation.id,
            fine: penalty.fine,
            deposit_deducted: penalty.depositDeducted,
            receivable: penalty.receivable,
            restriction: penalty.restriction,
            restriction_days: penalty.restrictionDays,
            identified_user: owner?.id ?? null,
          }),
        ],
      );

      return {
        ok: true,
        violation,
        identified: !!owner,
        restriction: penalty.restriction,
        restriction_days: penalty.restrictionDays,
        reasons: penalty.reasons,
      };
    });
  }

  private isRestrictionActive(v: any): boolean {
    if (v.booking_restriction === 'none') return false;
    if (v.status === 'closed' && Number(v.receivable) === 0) return false;
    const created = new Date(v.created_at).getTime();
    const until = created + Number(v.restriction_days) * 86400000;
    return Date.now() < until || Number(v.receivable) > 0;
  }
}
