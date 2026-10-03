-- 社区共享停车平台：完整库表结构
-- 覆盖：车位发布 -> 预约 -> 入场 -> 异常 -> 离场 -> 分账 全链路

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','driver','property','admin')),
  phone TEXT,
  credit_score INT NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS communities (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT
);

CREATE TABLE IF NOT EXISTS parking_spots (
  id BIGSERIAL PRIMARY KEY,
  community_id BIGINT NOT NULL REFERENCES communities(id),
  code TEXT NOT NULL,
  owner_id BIGINT NOT NULL REFERENCES users(id),
  location_desc TEXT,
  near_charger BOOLEAN NOT NULL DEFAULT false,
  charger_power_kw NUMERIC(6,1),
  allow_visitor BOOLEAN NOT NULL DEFAULT true,
  monthly_priority BOOLEAN NOT NULL DEFAULT false,
  hourly_rate NUMERIC(10,2) NOT NULL,
  overnight_cap NUMERIC(10,2),
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','approved','rejected','revoked')),
  review_remark TEXT,
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(community_id, code)
);

-- 可共享时段：weekday 0=周日 ... 6=周六；end_time <= start_time 表示跨天（如 19:00->08:00）
CREATE TABLE IF NOT EXISTS spot_share_windows (
  id BIGSERIAL PRIMARY KEY,
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id) ON DELETE CASCADE,
  weekday INT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  UNIQUE(spot_id, weekday)
);

CREATE TABLE IF NOT EXISTS vehicles (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plate TEXT NOT NULL,
  plate_color TEXT NOT NULL DEFAULT '蓝牌',
  is_new_energy BOOLEAN NOT NULL DEFAULT false,
  is_monthly BOOLEAN NOT NULL DEFAULT false,
  is_visitor BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, plate)
);

CREATE TABLE IF NOT EXISTS reservations (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id),
  driver_id BIGINT NOT NULL REFERENCES users(id),
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id),
  plate TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN (
    'reserved','admitted','in_garage','completed','cancelled','noshow'
  )),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','monthly')),
  estimated_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  gate_entry_at TIMESTAMPTZ,
  parking_confirmed_at TIMESTAMPTZ,
  gate_exit_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  settlement_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reservations_spot_time ON reservations(spot_id, start_at, end_at);

-- 同一笔停车服务的全链路事件：入场道闸/车牌识别/导航引导/计费/离场结算
CREATE TABLE IF NOT EXISTS service_events (
  id BIGSERIAL PRIMARY KEY,
  reservation_id BIGINT REFERENCES reservations(id),
  spot_id BIGINT REFERENCES parking_spots(id),
  type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id BIGINT REFERENCES users(id),
  actor_role TEXT,
  plate TEXT,
  gate TEXT,
  confidence NUMERIC(5,2),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_events_reservation ON service_events(reservation_id);
CREATE INDEX IF NOT EXISTS idx_events_spot_time ON service_events(spot_id, occurred_at);

-- 夜间调度异常工单
CREATE TABLE IF NOT EXISTS incident_tickets (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  spot_id BIGINT REFERENCES parking_spots(id),
  reservation_id BIGINT REFERENCES reservations(id),
  type TEXT NOT NULL CHECK (type IN (
    'owner_return','visitor_overstay','stranger_occupy','recognition_fail',
    'weak_signal','ice_occupy_charger','wrong_parking','manual_release'
  )),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','notified','resolved','closed','cancelled')),
  plate TEXT,
  reporter_role TEXT,
  description TEXT,
  resolution TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS move_notices (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES incident_tickets(id) ON DELETE CASCADE,
  target_plate TEXT NOT NULL,
  channel TEXT NOT NULL,
  message TEXT,
  delivered_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appeals (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  reservation_id BIGINT NOT NULL REFERENCES reservations(id),
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id),
  appellant_id BIGINT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  -- 申诉类型：普通错停 / 充电车位被燃油车错占
  appeal_type TEXT NOT NULL DEFAULT 'wrong_parking'
    CHECK (appeal_type IN ('wrong_parking','charging_occupy')),
  -- 充电位错占专项证据：充电桩编号、到达时间、占用车辆车牌
  charger_code TEXT,
  arrived_at TIMESTAMPTZ,
  occupying_plate TEXT,
  -- 补电补偿：预约期望充电量 vs 实际充电量（未充满缺口）
  requested_kwh NUMERIC(8,2),
  actual_kwh NUMERIC(8,2),
  recharge_compensation NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- 物业安排的替代充电桩编号
  alt_charger_code TEXT,
  -- 物业接单处置动作：contact_move / alternative_charger / waive_fee
  property_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  handled_by BIGINT REFERENCES users(id),
  handled_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','investigating','upheld','rejected','closed')),
  ruling TEXT CHECK (ruling IN (
    'driver_fault','owner_fault','platform_fault','property_fault','stranger','mixed','no_fault'
  )),
  ruling_note TEXT,
  ruled_by BIGINT REFERENCES users(id),
  ruled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appeal_evidence (
  id BIGSERIAL PRIMARY KEY,
  appeal_id BIGINT NOT NULL REFERENCES appeals(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN (
    'plate_recognition','reservation','photo','gate_log','owner_home','patrol','appeal_statement','signal'
  )),
  title TEXT NOT NULL,
  content TEXT,
  media_url TEXT,
  captured_at TIMESTAMPTZ,
  uploaded_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupons (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  used_reservation_id BIGINT REFERENCES reservations(id),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 结算单：业主收益/物业服务费/平台抽成/优惠券/退款/异常补偿合并清算
CREATE TABLE IF NOT EXISTS settlements (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  reservation_id BIGINT UNIQUE NOT NULL REFERENCES reservations(id),
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id),
  actual_entry_at TIMESTAMPTZ,
  actual_exit_at TIMESTAMPTZ,
  usable_from TIMESTAMPTZ,
  duration_minutes INT NOT NULL DEFAULT 0,
  base_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  charging_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  overtime_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  wrong_park_fine NUMERIC(10,2) NOT NULL DEFAULT 0,
  coupon_discount NUMERIC(10,2) NOT NULL DEFAULT 0,
  abnormal_compensation NUMERIC(10,2) NOT NULL DEFAULT 0,
  coupon_compensation NUMERIC(10,2) NOT NULL DEFAULT 0,
  owner_compensation NUMERIC(10,2) NOT NULL DEFAULT 0,
  prepaid NUMERIC(10,2) NOT NULL DEFAULT 0,
  refund NUMERIC(10,2) NOT NULL DEFAULT 0,
  exit_charge NUMERIC(10,2) NOT NULL DEFAULT 0,
  payable NUMERIC(10,2) NOT NULL DEFAULT 0,
  owner_income NUMERIC(10,2) NOT NULL DEFAULT 0,
  property_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  platform_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  owner_share NUMERIC(5,4) NOT NULL,
  property_share NUMERIC(5,4) NOT NULL,
  platform_share NUMERIC(5,4) NOT NULL,
  credit_target TEXT NOT NULL DEFAULT 'driver',
  credit_delta INT NOT NULL DEFAULT 0,
  appeal_id BIGINT REFERENCES appeals(id),
  ruling TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 资金流水（业主/车主/物业/平台/券池共同追溯）
CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  settlement_id BIGINT NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  account TEXT NOT NULL,           -- driver / owner:<uid> / property / platform / coupon_pool
  direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount NUMERIC(10,2) NOT NULL,
  memo TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_settlement ON ledger_entries(settlement_id);

CREATE TABLE IF NOT EXISTS patrol_logs (
  id BIGSERIAL PRIMARY KEY,
  spot_id BIGINT REFERENCES parking_spots(id),
  guard_id BIGINT REFERENCES users(id),
  plate TEXT,
  note TEXT,
  media_url TEXT,
  patrolled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 违约记录：燃油车占用充电位且无有效预约等，影响后续预约权限与押金规则
CREATE TABLE IF NOT EXISTS violation_records (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'ice_occupy_charger','stranger_occupy','wrong_parking','overstay','other'
  )),
  plate TEXT NOT NULL,
  -- 若系统可识别到车主账号则落账，否则挂账追缴
  user_id BIGINT REFERENCES users(id),
  spot_id BIGINT REFERENCES parking_spots(id),
  appeal_id BIGINT REFERENCES appeals(id),
  reservation_id BIGINT REFERENCES reservations(id),
  description TEXT,
  -- 违约时是否存在有效预约（无有效预约是影响权限/押金的关键条件）
  has_valid_reservation BOOLEAN NOT NULL DEFAULT false,
  fine NUMERIC(10,2) NOT NULL DEFAULT 0,           -- 违约金
  deposit_deducted NUMERIC(10,2) NOT NULL DEFAULT 0, -- 已从押金扣除金额
  amount_outstanding NUMERIC(10,2) NOT NULL DEFAULT 0, -- 挂账追缴余额
  credit_delta INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','recorded','deducted','collected','waived')),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_violations_plate ON violation_records(plate);
CREATE INDEX IF NOT EXISTS idx_violations_user ON violation_records(user_id);

-- 幂等迁移：为旧版本库补充后续新增列
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS coupon_compensation NUMERIC(10,2) NOT NULL DEFAULT 0;

-- 充电位错占补电补偿（未充满电量缺口的现金补偿，平台先行赔付后向违约车主追缴）
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS recharge_compensation NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS recharge_kwh_gap NUMERIC(8,2) NOT NULL DEFAULT 0;

-- 用户押金规则：押金余额 + 欠款挂账（违约扣押金/追缴）
ALTER TABLE users ADD COLUMN IF NOT EXISTS deposit_balance NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS outstanding_amount NUMERIC(10,2) NOT NULL DEFAULT 0;

-- 申诉专项字段（旧库补列）
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS appeal_type TEXT NOT NULL DEFAULT 'wrong_parking';
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS charger_code TEXT;
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS occupying_plate TEXT;
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS requested_kwh NUMERIC(8,2);
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS actual_kwh NUMERIC(8,2);
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS recharge_compensation NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS alt_charger_code TEXT;
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS property_actions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS handled_by BIGINT REFERENCES users(id);
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS handled_at TIMESTAMPTZ;
