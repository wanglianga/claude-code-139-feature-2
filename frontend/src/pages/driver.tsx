import { useState } from 'react';
import { api, qs } from '../api';
import { useLoader } from '../hooks';
import { WorkspaceShell } from '../App';
import { dt, money, Tag } from '../ui';
import { OrderTable } from './owner';
import { AppealDetailModal, ReservationDetailModal } from './shared';
import { SettlementView } from '../components';

type Session = any;
const NAV = [
  { key: 'browse', label: '找车位预约', icon: '🔍' },
  { key: 'active', label: '我的停车服务', icon: '🚗' },
  { key: 'vehicles', label: '车辆与优惠券', icon: '🎫' },
  { key: 'appeals', label: '充电位错占申诉', icon: '⚡' },
  { key: 'wallet', label: '押金与违约', icon: '🔒' },
];

export function DriverWorkspace({ session }: { session: Session }) {
  const [tab, setTab] = useState('browse');
  return (
    <WorkspaceShell session={session} nav={NAV} active={tab} onNav={setTab}>
      {tab === 'browse' && <BrowseTab />}
      {tab === 'active' && <OrdersTab />}
      {tab === 'vehicles' && <VehiclesTab />}
      {tab === 'appeals' && <AppealsTab />}
      {tab === 'wallet' && <WalletTab />}
    </WorkspaceShell>
  );
}

function PageHead({ title, desc, right }: any) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1><div className="desc">{desc}</div></div>
      {right}
    </div>
  );
}

// ---------- 找车位 ----------
function BrowseTab() {
  const [community, setCommunity] = useState('1');
  const [needCharger, setNeedCharger] = useState(false);
  const [visitor, setVisitor] = useState(false);
  const { data: communities } = useLoader<any[]>('/spots/communities');
  const query = qs({ community_id: community, need_charger: needCharger || undefined, visitor: visitor || undefined });
  const { data: spots, reload } = useLoader<any[]>(`/spots${query}`);
  const { data: vehicles } = useLoader<any[]>('/vehicles');
  const { data: coupons } = useLoader<any[]>('/coupons');
  const [booking, setBooking] = useState<any>(null);
  const [msg, setMsg] = useState('');

  return (
    <div>
      <PageHead title="找车位预约" desc="仅展示物业审核通过、当前在共享时段内的业主闲置车位；月租车在优先规则下排期" />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="filter-bar card" style={{ marginBottom: 16 }}>
        <label className="small muted">小区</label>
        <select value={community} onChange={(e) => setCommunity(e.target.value)}>
          {(communities ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="checkbox"><input type="checkbox" checked={needCharger} onChange={(e) => setNeedCharger(e.target.checked)} />仅看充电桩车位</label>
        <label className="checkbox"><input type="checkbox" checked={visitor} onChange={(e) => setVisitor(e.target.checked)} />允许访客车</label>
        <span className="small muted" style={{ marginLeft: 'auto' }}>{spots?.length ?? 0} 个可约车位</span>
      </div>
      <div className="grid grid-3">
        {(spots ?? []).map((s) => (
          <div className="spot-card" key={s.id}>
            <div className="btn-row" style={{ justifyContent: 'space-between' }}>
              <span className="code">{s.code}</span>
              {s.monthly_priority && <Tag cls="purple" label="月租优先" />}
            </div>
            <div className="loc">{s.community_name} · {s.location_desc}</div>
            <div className="spot-tags">
              {s.near_charger && <Tag cls="green" label={`⚡ ${s.charger_power_kw ?? 7}kW`} />}
              {s.allow_visitor ? <Tag cls="blue" label="访客可约" /> : <Tag cls="gray" label="禁访客" />}
              <Tag cls="gray" label={`业主 ${s.owner_name}`} />
            </div>
            <div className="small muted" style={{ minHeight: 34 }}>
              今日共享：{(s.windows ?? []).filter((w: any) => [new Date().getDay(), (new Date().getDay() + 6) % 7].includes(w.weekday))
                .map((w: any) => `${String(w.start_time).slice(0, 5)}-${String(w.end_time).slice(0, 5)}`).join(' / ') || '—'}
            </div>
            <div className="btn-row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <div className="price">{s.hourly_rate}<small> 元/时</small><div className="small muted" style={{ fontSize: 11 }}>夜间封顶 {s.overnight_cap ? money(s.overnight_cap) : '无'}</div></div>
              <button className="btn" onClick={() => setBooking(s)}>预约</button>
            </div>
          </div>
        ))}
      </div>
      {booking && (
        <BookingModal
          spot={booking}
          vehicles={vehicles ?? []}
          coupons={coupons ?? []}
          onClose={() => setBooking(null)}
          onDone={() => { setBooking(null); setMsg('预约成功：请在入场时使用车牌识别，道闸将自动放行并下发导航'); reload(); }}
        />
      )}
    </div>
  );
}

const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function BookingModal({ spot, vehicles, coupons, onClose, onDone }: any) {
  const startDefault = new Date(Date.now() + 15 * 60000);
  const endDefault = new Date(startDefault.getTime() + 3 * 3600000);
  const [vehicleId, setVehicleId] = useState<number | ''>(vehicles[0]?.id ?? '');
  const [start, setStart] = useState(toLocalInput(startDefault));
  const [end, setEnd] = useState(toLocalInput(endDefault));
  const [couponId, setCouponId] = useState<number | ''>('');
  const [targetPct, setTargetPct] = useState(90);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const availableCoupons = coupons.filter((c: any) => !c.used_at);
  const hours = (new Date(end).getTime() - new Date(start).getTime()) / 3600000;
  const estimate = Math.min(Number(spot.overnight_cap ?? 1e9), Math.max(0, hours) * Number(spot.hourly_rate));
  const coupon = availableCoupons.find((c: any) => c.id === couponId);
  const prepaid = Math.max(0, estimate - Number(coupon?.amount ?? 0));
  const isCharger = !!spot.near_charger;

  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      await api('POST', '/reservations', {
        spot_id: spot.id,
        vehicle_id: vehicleId,
        start_at: new Date(start).toISOString(),
        end_at: new Date(end).toISOString(),
        coupon_id: couponId || undefined,
        target_charge_pct: isCharger ? targetPct : undefined,
      });
      onDone();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head"><h3>预约车位 {spot.code}</h3><button className="close-x" onClick={onClose}>×</button></div>
        <div className="modal-body">
          {err && <div className="alert error">{err}</div>}
          <div className="field">
            <label>预约车辆</label>
            <select value={vehicleId} onChange={(e) => setVehicleId(Number(e.target.value))}>
              {vehicles.map((v: any) => (
                <option key={v.id} value={v.id}>
                  {v.plate}（{v.is_new_energy ? '新能源' : '燃油'}{v.is_monthly ? '·月租' : ''}{v.is_visitor ? '·访客' : ''}）
                </option>
              ))}
            </select>
            {vehicles.length === 0 && <div className="small" style={{ color: 'var(--red)' }}>请先在"车辆与优惠券"中登记车辆</div>}
          </div>
          <div className="form-row">
            <div className="field"><label>开始时间</label><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="field"><label>结束时间</label><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>
          <div className="field">
            <label>优惠券</label>
            <select value={couponId} onChange={(e) => setCouponId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">不使用</option>
              {availableCoupons.map((c: any) => <option key={c.id} value={c.id}>{c.code}（{money(c.amount)}）</option>)}
            </select>
          </div>
          {isCharger && (
            <div className="field">
              <label>目标充电量：{targetPct}%（到场被燃油车错占导致未充满时，按缺口计算补电补偿）</label>
              <input type="range" min={50} max={100} step={5} value={targetPct} onChange={(e) => setTargetPct(Number(e.target.value))} />
            </div>
          )}
          <div className="alert info">
            <div className="fee-grid">
              <div className="row"><span>预估费用（{hours.toFixed(1)} 小时）</span><span className="money">{money(estimate)}</span></div>
              <div className="row"><span>优惠券</span><span className="money">-{money(coupon?.amount ?? 0)}</span></div>
              <div className="row total"><span>预约预付</span><span className="money">{money(prepaid)}</span></div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" disabled={busy || !vehicleId} onClick={submit}>{busy ? '提交中…' : '确认预约并预付'}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- 我的停车服务（入场/停放/申诉/结算操作）----------
function OrdersTab() {
  const { data: orders, reload } = useLoader<any[]>('/reservations?scope=mine');
  const [detail, setDetail] = useState<number | null>(null);
  const [activeOrder, setActiveOrder] = useState<any>(null);
  const [settlement, setSettlement] = useState<{ id: number; data: any } | null>(null);

  return (
    <div>
      <PageHead title="我的停车服务" desc="从预约、道闸识别入场、导航引导、停放确认到离场结算，全部绑定同一笔服务单" right={
        <button className="btn ghost" onClick={reload}>刷新</button>
      } />
      <div className="card">
        <OrderTable orders={orders ?? []} onOpen={(id) => {
          const o = (orders ?? []).find((x) => x.id === id);
          if (['reserved', 'admitted', 'in_garage'].includes(o.status)) setActiveOrder(o);
          else setDetail(id);
        }} />
      </div>
      {detail && <ReservationDetailModal id={detail} onClose={() => setDetail(null)} />}
      {activeOrder && (
        <ServiceActionModal
          order={activeOrder}
          onClose={() => setActiveOrder(null)}
          onChanged={() => { setActiveOrder(null); reload(); }}
          onSettlement={(id: number, data: any) => setSettlement({ id, data })}
        />
      )}
      {settlement && (
        <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && setSettlement(null)}>
          <div className="modal wide">
            <div className="modal-head"><h3>离场结算单</h3><button className="close-x" onClick={() => setSettlement(null)}>×</button></div>
            <div className="modal-body"><SettlementView s={settlement.data} /></div>
          </div>
        </div>
      )}
    </div>
  );
}

function ServiceActionModal({ order, onClose, onChanged, onSettlement }: any) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [rec, setRec] = useState<any>(null);
  const [actualSpot, setActualSpot] = useState(order.spot_code);
  const [signalArea, setSignalArea] = useState('B2 层');
  const [actualPct, setActualPct] = useState(40);

  const act = async (fn: () => Promise<any>) => {
    setErr(''); setBusy(true);
    try { return await fn(); } catch (e: any) { setErr(e.message); return null; } finally { setBusy(false); }
  };

  const recognize = () => act(async () => {
    const r = await api('POST', '/operations/gate/recognize', { plate: order.plate, gate: '南门入口', confidence: 0.96 });
    setRec(r);
    return r;
  });
  const admit = (mode: 'auto' | 'manual') => act(async () => {
    await api('POST', '/operations/gate/admit', {
      reservation_id: order.id, plate: order.plate,
      gate: mode === 'auto' ? '南门入口' : '北门入口', mode,
      note: mode === 'manual' ? '识别不顺利，请物业核对预约码后人工放行' : undefined,
    });
    onChanged();
  });
  const guidance = () => act(async () => {
    const r = await api('POST', '/operations/navigation/guidance', { reservation_id: order.id, signal: 'good' });
    setRec((x: any) => ({ ...(x ?? {}), guidance: r }));
    return r;
  });
  const offlineGuidance = () => act(async () => {
    const r = await api('POST', '/operations/navigation/guidance', { reservation_id: order.id, signal: 'weak' });
    setRec((x: any) => ({ ...(x ?? {}), guidance: r }));
    return r;
  });
  const reportSignal = () => act(async () => api('POST', `/operations/reservations/${order.id}/report-signal`, { area: signalArea }));
  const parked = () => act(async () => {
    const r = await api('POST', `/operations/reservations/${order.id}/parked`, { actual_spot_code: actualSpot });
    if (r?.wrong_parking) {
      setRec((x: any) => ({ ...(x ?? {}), wrong: true }));
    } else {
      onChanged();
    }
    return r;
  });
  const exit = async () => {
    const r = await act(async () => api('POST', `/reservations/${order.id}/exit`, {
      charge_kwh: order.near_charger ? 20 : 0,
      actual_charge_pct: order.near_charger ? actualPct : undefined,
    }));
    if (r) { onSettlement(order.id, r); onChanged(); }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <h3>停车服务操作 · {order.code} <Tag status={order.status} /></h3>
          <button className="close-x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {err && <div className="alert error">{err}</div>}
          <div className="small muted" style={{ marginBottom: 12 }}>
            车位 {order.community_name} {order.spot_code} · {order.plate} · 预约 {dt(order.start_at)} ~ {dt(order.end_at)}
          </div>

          <div className="grid grid-2">
            <div className="card" style={{ marginTop: 0 }}>
              <h3>① 入场道闸</h3>
              <div className="btn-row">
                <button className="btn" disabled={busy || order.status !== 'reserved'} onClick={recognize}>📷 车牌识别</button>
                <button className="btn ghost" disabled={busy || order.status !== 'reserved'} onClick={() => admit('auto')}>识别成功 · 开闸</button>
                <button className="btn gray" disabled={busy || order.status !== 'reserved'} onClick={() => admit('manual')}>🙋 请物业人工放行</button>
              </div>
              {rec?.admitted === false && (
                <div className="alert error" style={{ marginTop: 10 }}>
                  识别未通过（{rec.reason === 'no_reservation' ? '无匹配预约' : '置信度过低'}），已自动生成识别失败工单，请联系物业人工核验
                </div>
              )}
              {rec?.admitted === true && (
                <div className="alert ok" style={{ marginTop: 10 }}>识别成功！置信度 {Math.round(rec.confidence * 100)}%，道闸已放行</div>
              )}
              {order.status !== 'reserved' && <div className="small muted" style={{ marginTop: 8 }}>车辆已入场（{dt(order.gate_entry_at)}）</div>}
            </div>

            <div className="card" style={{ marginTop: 0 }}>
              <h3>② 导航引导</h3>
              <div className="btn-row">
                <button className="btn ghost" disabled={busy || order.status === 'reserved'} onClick={guidance}>🧭 在线导航</button>
                <button className="btn gray" disabled={busy || order.status === 'reserved'} onClick={offlineGuidance}>📶 信号差 · 离线导航码</button>
              </div>
              {rec?.guidance && (
                <div className="nav-steps" style={{ marginTop: 10 }}>
                  <b>{rec.guidance.voice}{rec.guidance.offline_cached ? '（离线缓存）' : ''}</b>
                  <ol>{rec.guidance.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol>
                </div>
              )}
              <div className="btn-row" style={{ marginTop: 10 }}>
                <input style={{ width: 120 }} placeholder="信号弱区域" value={signalArea} onChange={(e) => setSignalArea(e.target.value)} />
                <button className="btn sm gray" disabled={busy || order.status === 'reserved'} onClick={reportSignal}>上报地下车库信号差</button>
              </div>
            </div>

            <div className="card">
              <h3>③ 停放确认（车位地磁/App 打卡）</h3>
              <div className="btn-row">
                <input style={{ width: 150 }} value={actualSpot} onChange={(e) => setActualSpot(e.target.value)} placeholder="实际停放车位号" />
                <button className="btn" disabled={busy || order.status !== 'admitted'} onClick={parked}>我已停好</button>
              </div>
              {rec?.wrong && (
                <div className="alert error" style={{ marginTop: 10 }}>
                  ⚠️ 检测到您停在 {actualSpot}，预约车位为 {order.spot_code}：已自动生成错停工单并发送挪车通知。
                  若确有客观原因（指示不清/被陌生车占用等），请立即在"错停申诉"中提交现场照片。
                </div>
              )}
              {order.status === 'in_garage' && <div className="alert ok" style={{ marginTop: 10 }}>已确认停放在预约车位，计费进行中</div>}
            </div>

            <div className="card">
              <h3>④ 离场结算</h3>
              <div className="small muted" style={{ marginBottom: 8 }}>
                系统将合并基础停车费{order.near_charger ? '、充电费' : ''}、超时/违约金、优惠券、异常补偿，
                按 业主 70% / 物业 10% / 平台 20% 清算；预付多退少补。
              </div>
              {order.near_charger && (
                <>
                  <div className="small muted" style={{ marginBottom: 4 }}>演示按充电 20kWh 结算（1.2 元/kWh）</div>
                  <div className="field">
                    <label>离场实际电量：{actualPct}%（若本单充电位被燃油车错占且终裁成立，低于目标电量将计算补电补偿）</label>
                    <input type="range" min={0} max={100} step={5} value={actualPct} onChange={(e) => setActualPct(Number(e.target.value))} />
                  </div>
                </>
              )}
              <button className="btn success" disabled={busy || !['admitted', 'in_garage'].includes(order.status)} onClick={exit}>
                道闸离场并查看清算单
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- 车辆与优惠券 ----------
function VehiclesTab() {
  const { data: vehicles, reload } = useLoader<any[]>('/vehicles');
  const { data: coupons } = useLoader<any[]>('/coupons');
  const [form, setForm] = useState({ plate: '', plate_color: '蓝牌', is_new_energy: false, is_monthly: false, is_visitor: false, battery_capacity_kwh: '' });
  const [err, setErr] = useState('');

  const submit = async () => {
    setErr('');
    try {
      await api('POST', '/vehicles', {
        ...form,
        battery_capacity_kwh: form.is_new_energy && form.battery_capacity_kwh ? Number(form.battery_capacity_kwh) : undefined,
      });
      setForm({ plate: '', plate_color: '蓝牌', is_new_energy: false, is_monthly: false, is_visitor: false, battery_capacity_kwh: '' });
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div>
      <PageHead title="车辆与优惠券" desc="登记车牌（入场道闸识别依据）；月租车与访客车标识影响预约规则" />
      <div className="grid grid-2">
        <div className="card">
          <h3>我的车辆</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>车牌</th><th>类型</th><th>标识</th></tr></thead>
              <tbody>
                {(vehicles ?? []).map((v) => (
                  <tr key={v.id}>
                    <td className="mono">{v.plate} <span className="small muted">{v.plate_color}</span></td>
                    <td>{v.is_new_energy ? `新能源${v.battery_capacity_kwh ? ` · ${v.battery_capacity_kwh}kWh` : ''}` : '燃油'}</td>
                    <td className="btn-row">
                      {v.is_monthly && <Tag cls="purple" label="月租" />}
                      {v.is_visitor && <Tag cls="cyan" label="访客" />}
                      {!v.is_monthly && !v.is_visitor && <span className="small muted">普通</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ height: 14 }} />
          {err && <div className="alert error">{err}</div>}
          <div className="form-row">
            <div className="field"><label>车牌号</label><input value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value.toUpperCase() })} placeholder="如 沪AD88899" /></div>
            <div className="field"><label>车牌颜色</label>
              <select value={form.plate_color} onChange={(e) => setForm({ ...form, plate_color: e.target.value })}>
                <option>蓝牌</option><option>绿牌</option><option>黄牌</option>
              </select>
            </div>
          </div>
          <div className="btn-row">
            <label className="checkbox"><input type="checkbox" checked={form.is_new_energy} onChange={(e) => setForm({ ...form, is_new_energy: e.target.checked })} />新能源</label>
            <label className="checkbox"><input type="checkbox" checked={form.is_monthly} onChange={(e) => setForm({ ...form, is_monthly: e.target.checked })} />月租车</label>
            <label className="checkbox"><input type="checkbox" checked={form.is_visitor} onChange={(e) => setForm({ ...form, is_visitor: e.target.checked })} />访客车</label>
            <button className="btn" onClick={submit} disabled={!form.plate}>登记车辆</button>
          </div>
          {form.is_new_energy && (
            <div className="field" style={{ marginTop: 10 }}>
              <label>电池容量 kWh（用于未充满时计算补电补偿，如 60）</label>
              <input type="number" value={form.battery_capacity_kwh}
                onChange={(e) => setForm({ ...form, battery_capacity_kwh: e.target.value })}
                placeholder="如 60" style={{ maxWidth: 220 }} />
            </div>
          )}
        </div>
        <div className="card">
          <h3>我的优惠券 <span className="hint">含异常赔付券</span></h3>
          {(coupons ?? []).length === 0 && <div className="empty">暂无优惠券</div>}
          <div className="grid" style={{ gap: 10 }}>
            {(coupons ?? []).map((c) => (
              <div key={c.id} className="spot-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div className="mono">{c.code}</div>
                  <div className="small muted">{c.used_at ? `已于 ${dt(c.used_at)} 使用（订单 #${c.used_reservation_id}）` : '未使用'}</div>
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--brand)' }}>{money(c.amount)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- 我的申诉 ----------
function AppealsTab() {
  const { data: appeals, reload } = useLoader<any[]>('/appeals');
  const { data: orders } = useLoader<any[]>('/reservations?scope=mine');
  const [creating, setCreating] = useState<'' | 'wrong_parking' | 'ice_charger'>('');
  const [openId, setOpenId] = useState<number | null>(null);
  const appealable = (orders ?? []).filter((o) => ['admitted', 'in_garage', 'completed'].includes(o.status));

  return (
    <div>
      <PageHead title="充电位错占申诉" desc="新能源车主预约带充电桩车位后被燃油车占用：上传现场照片、充电桩编号与到达时间，平台自动调取占用车辆入场记录；物业可联系挪车/安排替代桩/免除费用，未充满时计算补电补偿" right={
        <span className="btn-row">
          <button className="btn ghost" disabled={appealable.length === 0} onClick={() => setCreating('wrong_parking')}>普通错停申诉</button>
          <button className="btn" disabled={appealable.length === 0} onClick={() => setCreating('ice_charger')}>⚡ 充电位被燃油车占用</button>
        </span>
      } />
      <div className="card">
        {(appeals ?? []).length === 0 && <div className="empty">暂无申诉记录</div>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>申诉单</th><th>类型</th><th>车位/车牌</th><th>事由</th><th>状态/裁决</th><th></th></tr></thead>
            <tbody>
              {(appeals ?? []).map((a) => (
                <tr key={a.id}>
                  <td className="mono small">{a.code}<div className="small muted">{dt(a.created_at)}</div></td>
                  <td>{a.appeal_type === 'ice_charger' ? <Tag cls="purple" label="⚡ 燃油车占充电位" /> : <Tag cls="gray" label="普通错停" />}</td>
                  <td>{a.spot_code}<div className="small muted mono">{a.plate}</div></td>
                  <td className="small">{a.reason}</td>
                  <td><Tag status={a.status} /></td>
                  <td><button className="btn sm gray" onClick={() => setOpenId(a.id)}>证据链/裁决</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {creating && <CreateAppealModal type={creating} orders={appealable} onClose={() => setCreating('')} onDone={() => { setCreating(''); reload(); }} />}
      {openId && <AppealView id={openId} onClose={() => { setOpenId(null); reload(); }} />}
    </div>
  );
}

function AppealView({ id, onClose }: { id: number; onClose: () => void }) {
  return <AppealDetailModal id={id} onClose={onClose} />;
}

function CreateAppealModal({ type, orders, onClose, onDone }: any) {
  const ice = type === 'ice_charger';
  const iceOrders = orders.filter((o: any) => o.near_charger);
  const [reservationId, setReservationId] = useState((ice ? iceOrders[0]?.id : orders[0]?.id) ?? '');
  const [reason, setReason] = useState('');
  const [photoNote, setPhotoNote] = useState('');
  const [photoUrl, setPhotoUrl] = useState(`evidence/ice-${Date.now()}.jpg`);
  const [chargerCode, setChargerCode] = useState('');
  const [arrivalAt, setArrivalAt] = useState(toLocalInput(new Date()));
  const [occupierPlate, setOccupierPlate] = useState('');
  const [targetPct, setTargetPct] = useState(90);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<any>(null);

  const submit = async () => {
    setErr('');
    try {
      if (ice) {
        const r = await api('POST', '/appeals', {
          reservation_id: reservationId,
          appeal_type: 'ice_charger',
          reason: reason || '到场发现预约充电位被燃油车占用，无法充电',
          photo_url: photoUrl,
          charger_code: chargerCode,
          arrival_at: new Date(arrivalAt).toISOString(),
          occupier_plate: occupierPlate || undefined,
          target_charge_pct: targetPct,
        });
        setResult(r);
      } else {
        const r = await api('POST', '/appeals', {
          reservation_id: reservationId,
          reason,
          evidence: photoNote
            ? [{ source: 'photo', title: '现场照片说明', content: photoNote, captured_at: new Date().toISOString(), stance: 'support' }]
            : [],
        });
        setResult(r);
      }
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const list = ice ? iceOrders : orders;

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head"><h3>{ice ? '⚡ 充电位被燃油车占用申诉' : '发起错停申诉'}</h3><button className="close-x" onClick={onClose}>×</button></div>
        <div className="modal-body">
          {!result ? (
            <div>
              {err && <div className="alert error">{err}</div>}
              {ice && list.length === 0 && (
                <div className="alert error">没有可申诉的新能源充电位订单（需已入场/在场/已完成的充电位预约）</div>
              )}
              <div className="field">
                <label>关联充电位预约单</label>
                <select value={reservationId} onChange={(e) => setReservationId(Number(e.target.value))}>
                  {list.map((o: any) => <option key={o.id} value={o.id}>{o.code} · {o.spot_code} · {o.plate} · {dt(o.start_at)}</option>)}
                </select>
              </div>

              {ice ? (
                <>
                  <div className="grid grid-2">
                    <div className="field">
                      <label>现场充电桩编号 *</label>
                      <input value={chargerCode} onChange={(e) => setChargerCode(e.target.value)} placeholder="如 CHG-B2-03" />
                    </div>
                    <div className="field">
                      <label>到达时间 *</label>
                      <input type="datetime-local" value={arrivalAt} onChange={(e) => setArrivalAt(e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-2">
                    <div className="field">
                      <label>占用车辆车牌（燃油车，填写后自动调取其入场记录）</label>
                      <input className="mono" value={occupierPlate} onChange={(e) => setOccupierPlate(e.target.value.toUpperCase())} placeholder="如 沪A98765（可留空，由巡查补录）" />
                    </div>
                    <div className="field">
                      <label>预约目标电量：{targetPct}%</label>
                      <input type="range" min={50} max={100} step={5} value={targetPct} onChange={(e) => setTargetPct(Number(e.target.value))} />
                    </div>
                  </div>
                  <div className="field">
                    <label>现场照片 *（上传 OSS 后的附件名/链接）</label>
                    <input value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} placeholder="evidence/xxx.jpg" />
                    <div className="small muted">照片需清晰拍到：被占充电位、充电桩编号、占用车辆（含车牌）与车辆非新能源特征</div>
                  </div>
                  <div className="field">
                    <label>情况说明</label>
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：到达 B2-108，充电桩 CHG-B2-03 被一辆黑色燃油车占用，等待 30 分钟仍未挪车，最终未能充满" />
                  </div>
                  <div className="alert info">
                    提交后平台将：① 汇聚你的现场照片、充电桩编号、到达时间；② 自动调取占用车辆的道闸入场记录（核验是否燃油车、有无有效预约）；
                    ③ 推送物业接单处置（联系挪车 / 安排替代充电桩 / 免除预约费用）；④ 终裁后对无有效预约的燃油车记违约（违约金、押金、信用与预约权限）；
                    ⑤ 若因此未充满，离场结算时自动计算补电补偿（缺口电量 + 等待时长 + 替代桩绕行）。
                  </div>
                  <button className="btn" disabled={!chargerCode || list.length === 0} onClick={submit}>提交充电位错占申诉</button>
                </>
              ) : (
                <>
                  <div className="field">
                    <label>关联停车服务单</label>
                    <select value={reservationId} onChange={(e) => setReservationId(Number(e.target.value))}>
                      {orders.map((o: any) => <option key={o.id} value={o.id}>{o.code} · {o.spot_code} · {o.plate} · {dt(o.start_at)}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label>申诉事由</label>
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：到场发现车位被陌生车占用 / 导航信号中断被引导至错误区域 / 业主临时回家要求挪车…" />
                  </div>
                  <div className="field">
                    <label>现场照片说明（上传 OSS 后在此描述照片内容与链接）</label>
                    <textarea value={photoNote} onChange={(e) => setPhotoNote(e.target.value)} placeholder="如：照片显示车位标牌 B2-109，地面箭头磨损；附件 evidence/xxx.jpg" />
                  </div>
                  <div className="alert info">提交后系统立即自动分析：车牌识别记录、预约记录、道闸日志、业主回家上报时间、物业巡查档案与你的陈述/照片。</div>
                  <button className="btn" disabled={!reason} onClick={submit}>提交申诉并查看自动责任分析</button>
                </>
              )}
            </div>
          ) : (
            <div>
              <div className="alert ok">申诉已受理（{result.appeal.code}），自动责任分析已生成，物业将据此处置与终裁</div>
              {ice && (
                <div className="alert info">
                  占用车辆：{result.adjudication.occupierPlate ?? '车牌待核（等待物业巡查补录）'}；
                  建议结论：<RulingTagInline ruling={result.adjudication.ruling} />
                </div>
              )}
              <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>
                建议结论：{result.adjudication.ruling}（置信度 {Math.round(result.adjudication.confidence * 100)}%）{'\n'}
                {result.adjudication.reasons.join('\n')}
              </pre>
              <button className="btn" onClick={onDone}>完成</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RulingTagInline({ ruling }: { ruling: string }) {
  const map: Record<string, string> = { stranger: '陌生燃油车主责任', driver_fault: '车主责任', mixed: '混合责任', no_fault: '存疑/无责' };
  return <b>{map[ruling] ?? ruling}</b>;
}

// ---------- 押金与违约 ----------
function WalletTab() {
  const { data, reload } = useLoader<any>('/wallet');
  const [amount, setAmount] = useState(100);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const topup = async () => {
    setErr(''); setMsg('');
    try {
      await api('POST', '/wallet/deposit/topup', { amount });
      setMsg(`押金充值 ${money(amount)} 成功`);
      reload();
    } catch (e: any) { setErr(e.message); }
  };
  const repay = async (id: number) => {
    setErr(''); setMsg('');
    try {
      await api('POST', `/violations/${id}/repay`, {});
      setMsg('挂账已补缴，押金余额更新，预约权限恢复');
      reload();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <div>
      <PageHead title="押金与违约" desc="押金用于违约情形下的资金保障；燃油车无有效预约占用充电位将被没收押金/记违约，影响后续预约权限，可在此补缴恢复" />
      {msg && <div className="alert ok">{msg}</div>}
      {err && <div className="alert error">{err}</div>}
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="stat"><div className="label">押金余额</div><div className="value">{money(data?.deposit_balance ?? 0)}</div></div>
        <div className="stat"><div className="label">信用分</div><div className="value">{data?.credit_score ?? 100}</div></div>
        <div className="stat"><div className="label">生效违约限制</div>
          <div className="value" style={{ color: (data?.active_restrictions?.length ?? 0) ? 'var(--red)' : undefined }}>{data?.active_restrictions?.length ?? 0}</div></div>
      </div>
      <div className="grid grid-2">
        <div className="card">
          <h3>押金充值</h3>
          <div className="btn-row">
            <input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} style={{ maxWidth: 160 }} />
            <button className="btn" onClick={topup}>充值押金</button>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>押金用于充电位等场景的违约保障；无违约时可申请退还（演示环境不提供退款入口）。</div>
          <h3 style={{ marginTop: 16 }}>押金流水</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>时间</th><th>类型</th><th>金额</th><th>摘要</th></tr></thead>
              <tbody>
                {(data?.transactions ?? []).map((t: any) => (
                  <tr key={t.id}>
                    <td className="small">{dt(t.created_at)}</td>
                    <td>{t.direction === 'topup' ? '充值' : t.direction === 'deduct' ? '违约没收' : t.direction === 'repay' ? '挂账补缴' : '退还'}</td>
                    <td className="money">{money(t.amount)}</td>
                    <td className="small">{t.memo}</td>
                  </tr>
                ))}
                {(data?.transactions ?? []).length === 0 && <tr><td colSpan={4} className="empty">暂无流水</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h3>我的违约记录</h3>
          {(data?.violations ?? []).length === 0 && <div className="empty">暂无违约记录</div>}
          {(data?.violations ?? []).map((v: any) => (
            <div key={v.id} className={`ticket-card ${v.booking_restriction === 'blocked' ? 'open' : v.booking_restriction === 'restricted' ? 'notified' : 'resolved'}`}>
              <div className="ticket-head">
                <span className="ticket-title mono">{v.code} · {v.plate}</span>
                <Tag cls={v.booking_restriction === 'blocked' ? 'red' : v.booking_restriction === 'restricted' ? 'amber' : 'green'}
                  label={v.booking_restriction === 'blocked' ? '停约' : v.booking_restriction === 'restricted' ? '限制预约' : '无限制'} />
              </div>
              <div className="ticket-desc small">{v.note}</div>
              <div className="small muted">
                违约金 {money(v.fine)} · 押金没收 {money(v.deposit_deducted)} · 挂账待缴 {money(v.receivable)} · 信用 {v.credit_delta}
              </div>
              {Number(v.receivable) > 0 && <button className="btn sm danger" style={{ marginTop: 6 }} onClick={() => repay(v.id)}>补缴挂账 {money(v.receivable)} 恢复预约</button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
