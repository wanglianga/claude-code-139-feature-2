import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLoader } from '../hooks';
import { WorkspaceShell } from '../App';
import { dt, INCIDENT_LABEL, money, Tag } from '../ui';
import { OrderTable } from './owner';
import { AppealDetailModal, ReservationDetailModal } from './shared';

type Session = any;
const NAV = [
  { key: 'review', label: '车位审核', icon: '✅' },
  { key: 'gate', label: '道闸操作台', icon: '🚧' },
  { key: 'dispatch', label: '夜间调度看板', icon: '🌙' },
  { key: 'patrol', label: '巡查登记', icon: '🔦' },
  { key: 'appeals', label: '申诉裁决', icon: '⚖️' },
  { key: 'violations', label: '违约追缴', icon: '🧾' },
  { key: 'orders', label: '订单追溯', icon: '🚗' },
];

export function PropertyWorkspace({ session }: { session: Session }) {
  const [tab, setTab] = useState('dispatch');
  return (
    <WorkspaceShell session={session} nav={NAV} active={tab} onNav={setTab}>
      {tab === 'review' && <ReviewTab />}
      {tab === 'gate' && <GateTab />}
      {tab === 'dispatch' && <DispatchTab />}
      {tab === 'patrol' && <PatrolTab />}
      {tab === 'appeals' && <AppealsTab />}
      {tab === 'violations' && <ViolationsTab />}
      {tab === 'orders' && <OrdersTab />}
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

// ---------- 车位审核 ----------
function ReviewTab() {
  const { data: pending, reload } = useLoader<any[]>('/spots/review/pending');
  const [remark, setRemark] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');

  const review = async (s: any, pass: boolean) => {
    await api('POST', `/spots/${s.id}/review`, { pass, remark: remark[s.id] ?? (pass ? '产权材料齐全' : '产权证明待补充') });
    setMsg(`车位 ${s.code} 已${pass ? '审核通过' : '驳回'}`);
    reload();
  };

  return (
    <div>
      <PageHead title="车位发布审核" desc="核验业主车位产权证明、充电桩位置与共享时段，通过后车主方可预约" />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="card">
        <h3>待审核队列 <span className="hint">{pending?.length ?? 0} 个</span></h3>
        {(pending ?? []).length === 0 && <div className="empty">没有待审核车位</div>}
        {(pending ?? []).map((s) => (
          <div className="ticket-card open" key={s.id}>
            <div className="ticket-head">
              <span className="ticket-title">{s.community_name} · {s.code}</span>
              <span className="small muted">{s.owner_name} {s.owner_phone}</span>
            </div>
            <div className="ticket-desc">
              {s.location_desc} · {s.hourly_rate} 元/时{s.overnight_cap ? ` · 封顶 ${s.overnight_cap}` : ''} · {dt(s.created_at)} 提交
            </div>
            <div className="spot-tags">
              {s.near_charger && <Tag cls="green" label={`⚡ 充电桩 ${s.charger_power_kw ?? ''}kW`} />}
              {s.allow_visitor ? <Tag cls="blue" label="允许访客" /> : <Tag cls="gray" label="禁访客" />}
              {s.monthly_priority && <Tag cls="purple" label="月租优先" />}
            </div>
            <div className="btn-row" style={{ marginTop: 8 }}>
              <input style={{ maxWidth: 360 }} placeholder="审核备注（产权材料 / 现场核验）"
                value={remark[s.id] ?? ''} onChange={(e) => setRemark((m) => ({ ...m, [s.id]: e.target.value }))} />
              <button className="btn success sm" onClick={() => review(s, true)}>通过</button>
              <button className="btn danger sm" onClick={() => review(s, false)}>驳回</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 道闸操作台 ----------
function GateTab() {
  const [plate, setPlate] = useState('沪AD88899');
  const [gate, setGate] = useState('南门入口');
  const [rec, setRec] = useState<any>(null);
  const [err, setErr] = useState('');
  const [confidence, setConfidence] = useState(0.96);

  const recognize = async () => {
    setErr('');
    try {
      const r = await api('POST', '/operations/gate/recognize', { plate, gate, confidence });
      setRec(r);
    } catch (e: any) { setErr(e.message); }
  };
  const admit = async (mode: 'auto' | 'manual') => {
    setErr('');
    try {
      if (!rec?.reservation?.id) { setErr('请先识别到匹配预约'); return; }
      await api('POST', '/operations/gate/admit', {
        reservation_id: rec.reservation.id, plate, gate, mode, confidence,
        note: mode === 'manual' ? '物业核对预约码后人工放行' : undefined,
      });
      setRec({ ...rec, admitted: true, justAdmitted: true });
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <div>
      <PageHead title="道闸操作台" desc="摄像头车牌识别 → 匹配当晚预约 → 自动放行并下发导航；识别失败时转人工核验放行，全过程写入同一笔停车服务" />
      <div className="grid grid-2">
        <div className="card">
          <h3>入场识别</h3>
          {err && <div className="alert error">{err}</div>}
          <div className="form-row">
            <div className="field"><label>识别车牌</label><input className="mono" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} /></div>
            <div className="field"><label>道闸</label>
              <select value={gate} onChange={(e) => setGate(e.target.value)}>
                <option>南门入口</option><option>北门入口</option><option>地库 B2 入口</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>识别置信度：{Math.round(confidence * 100)}%（低于 75% 判识别失败）</label>
            <input type="range" min={0.3} max={0.99} step={0.01} value={confidence} onChange={(e) => setConfidence(Number(e.target.value))} />
          </div>
          <div className="btn-row">
            <button className="btn" onClick={recognize}>📷 识别</button>
            <button className="btn ghost" disabled={!rec?.reservation} onClick={() => admit('auto')}>自动放行</button>
            <button className="btn gray" disabled={!rec?.reservation} onClick={() => admit('manual')}>人工核验放行</button>
          </div>
        </div>
        <div className="card">
          <h3>识别结果</h3>
          {!rec && <div className="empty">等待识别…</div>}
          {rec && (
            <div>
              {rec.justAdmitted && <div className="alert ok">已{rec.manual ? '人工' : '自动'}开闸放行，入场事件已绑定服务单</div>}
              <div className="btn-row" style={{ marginBottom: 10 }}>
                {rec.admitted ? <Tag cls="green" label="准予放行" /> : <Tag cls="red" label="拒绝入场" />}
                <span className="small muted">置信度 {Math.round((rec.confidence ?? 0) * 100)}%</span>
                {rec.ticket_id && <Tag cls="amber" label={`识别失败工单 #${rec.ticket_id}`} />}
              </div>
              {rec.reason && <div className="small muted">原因：{rec.reason === 'no_reservation' ? '无匹配预约' : rec.reason === 'recognition_low_confidence' ? '识别置信度过低' : rec.reason}</div>}
              {rec.reservation && (
                <div style={{ marginTop: 8 }}>
                  <div>预约单 <b>#{rec.reservation.id}</b> · 车位 <b className="mono">{rec.reservation.spot_code}</b></div>
                  <div className="small muted">{rec.reservation.community_name} · {rec.reservation.location_desc}</div>
                  <div className="spot-tags" style={{ marginTop: 8 }}>
                    {rec.reservation.is_new_energy && <Tag cls="green" label="新能源" />}
                    {rec.reservation.is_visitor && <Tag cls="cyan" label="访客车" />}
                  </div>
                </div>
              )}
              {rec.guidance && (
                <div className="nav-steps" style={{ marginTop: 12 }}>
                  <b>{rec.guidance.voice}</b>
                  <ol>{rec.guidance.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- 夜间调度看板 ----------
function DispatchTab() {
  const [status, setStatus] = useState('');
  const { data: tickets, reload } = useLoader<any[]>(`/dispatch/incidents${status ? `?status=${status}` : ''}`);
  const { data: overview } = useLoader<any>('/dispatch/overview');
  const [openNotices, setOpenNotices] = useState<any | null>(null);
  const [msg, setMsg] = useState('');

  const notify = async (t: any) => {
    await api('POST', `/dispatch/incidents/${t.id}/notify`, {});
    setMsg(`挪车通知已发送至 ${t.plate}（App 推送 + 车位 LED 屏）`);
    reload();
  };
  const resolve = async (t: any) => {
    const resolution = prompt('处置结果说明', t.type === 'stranger_occupy' ? '陌生车辆已劝离' : '已处置完成');
    if (resolution === null) return;
    const waive = t.type === 'visitor_overstay' ? confirm('是否豁免该单超时费？') : false;
    await api('POST', `/dispatch/incidents/${t.id}/resolve`, { resolution, waive_overtime: waive });
    setMsg(`工单 ${t.code} 已关闭`);
    reload();
  };
  const overstay = async () => {
    const id = prompt('输入访客超时的预约单 ID');
    if (!id) return;
    await api('POST', '/dispatch/overstay', { reservation_id: Number(id) });
    setMsg('超时预警与挪车通知已发送');
    reload();
  };

  const counts: Record<string, number> = {};
  for (const x of overview?.incidents_24h ?? []) counts[`${x.type}:${x.status}`] = x.n;

  return (
    <div>
      <PageHead title="夜间调度看板" desc="集中处理业主临时回家、访客超时、陌生车占用、识别失败、信号差、燃油车占充电位、人工放行等夜间事件" right={
        <button className="btn ghost" onClick={overstay}>访客超时预警</button>
      } />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {Object.entries(INCIDENT_LABEL).map(([k, label]) => {
          const open = (overview?.incidents_24h ?? []).filter((x: any) => x.type === k && ['open', 'notified'].includes(x.status)).reduce((a: number, b: any) => a + b.n, 0);
          return (
            <div className="stat" key={k}>
              <div className="label">{label}</div>
              <div className="value" style={{ color: open > 0 ? 'var(--red)' : undefined }}>{open}</div>
              <div className="sub">待处理（24h）</div>
            </div>
          );
        })}
      </div>
      <div className="card">
        <div className="filter-bar">
          <h3 style={{ margin: 0 }}>异常工单</h3>
          <span style={{ flex: 1 }} />
          {[['', '全部'], ['open', '待处理'], ['notified', '已通知'], ['resolved', '已解决']].map(([v, l]) => (
            <button key={v} className={`btn sm ${status === v ? '' : 'gray'}`} onClick={() => setStatus(v)}>{l}</button>
          ))}
        </div>
        {(tickets ?? []).length === 0 && <div className="empty">当前没有工单</div>}
        {(tickets ?? []).map((t) => (
          <div key={t.id} className={`ticket-card ${t.status}`}>
            <div className="ticket-head">
              <span className="ticket-title">{t.label} <span className="mono small muted">{t.code}</span></span>
              <span className="btn-row"><span className="mono">{t.plate ?? '车牌待核'}</span><Tag status={t.status} /></span>
            </div>
            <div className="ticket-desc">{t.description}</div>
            <div className="small muted">
              {dt(t.created_at)} · {t.community_name} {t.spot_code ?? ''} {t.reservation_code ? `· 订单 ${t.reservation_code}` : ''}
            </div>
            {t.resolution && <div className="small" style={{ marginTop: 4 }}>处置结果：{t.resolution}</div>}
            <div className="btn-row" style={{ marginTop: 8 }}>
              {['open', 'notified'].includes(t.status) && (
                <>
                  <button className="btn sm ghost" onClick={() => notify(t)}>📨 派发挪车通知</button>
                  <button className="btn sm success" onClick={() => resolve(t)}>处置完成</button>
                  <button className="btn sm gray" onClick={() => setOpenNotices(t)}>通知记录</button>
                </>
              )}
              {t.status === 'resolved' && <button className="btn sm gray" onClick={() => setOpenNotices(t)}>通知记录</button>}
            </div>
          </div>
        ))}
      </div>
      {openNotices && <NoticesModal ticket={openNotices} onClose={() => setOpenNotices(null)} />}
    </div>
  );
}

function NoticesModal({ ticket, onClose }: { ticket: any; onClose: () => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => {
    api('GET', `/dispatch/incidents/${ticket.id}/notices`).then(setItems);
  }, [ticket.id]);
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head"><h3>挪车通知记录 · {ticket.code}</h3><button className="close-x" onClick={onClose}>×</button></div>
        <div className="modal-body">
          {!items ? <div className="empty">加载中…</div> : items.length === 0 ? <div className="empty">尚未发送通知</div> : (
            items.map((n) => (
              <div key={n.id} className="ticket-card resolved">
                <div className="ticket-head"><span className="mono">{n.target_plate}</span><Tag cls="blue" label={n.channel} /></div>
                <div className="ticket-desc">{n.message}</div>
                <div className="small muted">送达 {dt(n.delivered_at)}{n.acknowledged_at ? ` · 确认 ${dt(n.acknowledged_at)}` : ' · 未确认'}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- 巡查登记 ----------
function PatrolTab() {
  const { data: spots } = useLoader<any[]>('/spots');
  const { data: logs, reload } = useLoader<any[]>('/operations/patrol');
  const [spotId, setSpotId] = useState<number | ''>('');
  const [plate, setPlate] = useState('');
  const [finding, setFinding] = useState<'normal' | 'stranger' | 'wrong_park' | 'ice_on_charger'>('stranger');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const submit = async () => {
    setErr('');
    if (!spotId) { setErr('请选择巡查车位'); return; }
    try {
      const r = await api('POST', '/operations/patrol', {
        spot_id: spotId, plate: plate || undefined, finding, note: note || undefined,
        media_url: `evidence/patrol-${Date.now()}.jpg`,
      });
      setMsg(`巡查已登记${r.ticket_id ? '，并自动生成异常工单' : ''}`);
      setPlate(''); setNote('');
      reload();
    } catch (e: any) { setErr(e.message); }
  };

  const FINDINGS = [
    { v: 'normal', l: '正常', c: 'green' },
    { v: 'stranger', l: '陌生车辆占用', c: 'red' },
    { v: 'wrong_park', l: '车主停错车位', c: 'amber' },
    { v: 'ice_on_charger', l: '燃油车占充电位', c: 'purple' },
  ] as const;

  return (
    <div>
      <PageHead title="物业巡查登记" desc="夜巡发现陌生车、错停或燃油车占用充电位时登记，照片自动进入相关申诉的证据链" />
      {msg && <div className="alert ok">{msg}</div>}
      {err && <div className="alert error">{err}</div>}
      <div className="grid grid-2">
        <div className="card">
          <h3>现场登记</h3>
          <div className="field">
            <label>巡查车位</label>
            <select value={spotId} onChange={(e) => setSpotId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">请选择车位</option>
              {(spots ?? []).map((s: any) => (
                <option key={s.id} value={s.id}>{s.community_name} · {s.code}（{s.location_desc}）</option>
              ))}
            </select>
          </div>
          <div className="field"><label>现场车牌（如有）</label><input className="mono" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} /></div>
          <div className="field">
            <label>巡查发现</label>
            <div className="btn-row">
              {FINDINGS.map((f) => (
                <button key={f.v} className={`btn sm ${finding === f.v ? '' : 'gray'}`} style={finding === f.v ? undefined : undefined} onClick={() => setFinding(f.v as any)}>{f.l}</button>
              ))}
            </div>
          </div>
          <div className="field"><label>情况说明 / 现场照片附件名</label><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：夜间巡查发现非预约燃油车停放在 B2-108 充电位，已拍照" /></div>
          <button className="btn" onClick={submit}>提交巡查记录</button>
        </div>
        <div className="card">
          <h3>近期巡查档案</h3>
          {(logs ?? []).length === 0 && <div className="empty">暂无巡查记录</div>}
          {(logs ?? []).map((p) => (
            <div key={p.id} className="ticket-card resolved">
              <div className="ticket-head">
                <span className="ticket-title">车位 #{p.spot_id} {p.plate ? `· ${p.plate}` : ''}</span>
                <span className="small muted">{p.guard_name} · {dt(p.patrolled_at)}</span>
              </div>
              <div className="ticket-desc">{p.note}</div>
              {p.media_url && <div className="small muted">📎 {p.media_url}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- 申诉裁决 ----------
function AppealsTab() {
  const { data: appeals, reload } = useLoader<any[]>('/appeals');
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState<'open' | 'closed' | ''>('');
  const list = (appeals ?? []).filter((a) => (filter ? a.status === filter || (filter === 'closed' && a.status === 'closed') : true));

  return (
    <div>
      <PageHead title="错停申诉裁决" desc="系统已基于六类证据给出责任建议；物业可直接采纳或人工改判，终裁后可一键重算分账与信用" />
      <div className="card">
        <div className="filter-bar">
          <h3 style={{ margin: 0 }}>申诉列表</h3>
          <span style={{ flex: 1 }} />
          {[['', '全部'], ['open', '待裁决'], ['closed', '已终裁']].map(([v, l]) => (
            <button key={v} className={`btn sm ${filter === v ? '' : 'gray'}`} onClick={() => setFilter(v as any)}>{l}</button>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>申诉单</th><th>车主</th><th>车位/车牌</th><th>事由</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td className="mono small">{a.code}{a.appeal_type === 'charging_occupy' && <Tag cls="purple" label="⚡充电位" />}<div className="small muted">{dt(a.created_at)}</div></td>
                  <td>{a.appellant_name}</td>
                  <td>{a.spot_code}<div className="small muted mono">{a.reservation_code} · {a.plate}</div></td>
                  <td className="small" style={{ maxWidth: 280 }}>{a.reason}</td>
                  <td><Tag status={a.status === 'closed' ? 'closed' : 'investigating'} /></td>
                  <td><button className="btn sm" onClick={() => setOpen(a.id)}>{a.status === 'closed' ? '查看/重算' : '裁决'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {open && <AppealDetailModal id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

// ---------- 违约追缴（燃油车占充电位等）----------
function ViolationsTab() {
  const [plate, setPlate] = useState('');
  const query = plate ? `?plate=${encodeURIComponent(plate)}` : '';
  const { data: list, reload } = useLoader<any[]>(`/violations${query}`);

  const stats = (list ?? []).reduce(
    (acc, v) => {
      acc.fine += Number(v.fine);
      acc.deducted += Number(v.deposit_deducted);
      acc.outstanding += Number(v.amount_outstanding);
      return acc;
    },
    { fine: 0, deducted: 0, outstanding: 0 },
  );

  return (
    <div>
      <PageHead title="占位违约追缴" desc="燃油车占用充电位且无有效预约的违约记录：信用 -10、违约金 ¥200 优先扣押金、不足挂账追缴，并影响后续预约权限与押金门槛" />
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="stat"><div className="label">违约罚金合计</div><div className="value">{money(stats.fine)}</div><div className="sub">{list?.length ?? 0} 条记录</div></div>
        <div className="stat"><div className="label">已从押金扣除</div><div className="value text-green" style={{ color: 'var(--green)' }}>{money(stats.deducted)}</div><div className="sub">已追缴入账</div></div>
        <div className="stat"><div className="label">挂账追缴余额</div><div className="value" style={{ color: stats.outstanding > 0 ? 'var(--red)' : undefined }}>{money(stats.outstanding)}</div><div className="sub">车主补缴/押金补足后结清</div></div>
      </div>
      <div className="card">
        <div className="filter-bar">
          <h3 style={{ margin: 0 }}>违约记录</h3>
          <span style={{ flex: 1 }} />
          <input className="mono" style={{ width: 180 }} placeholder="按车牌检索" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} />
          <button className="btn sm ghost" onClick={reload}>刷新</button>
        </div>
        {(list ?? []).length === 0 && <div className="empty">暂无违约记录</div>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>单号</th><th>类型</th><th>车牌</th><th>车主账号</th><th>车位</th><th>有效预约</th><th>罚金</th><th>押金抵扣</th><th>挂账</th><th>信用</th><th>状态</th><th>时间</th></tr></thead>
            <tbody>
              {(list ?? []).map((v) => (
                <tr key={v.id}>
                  <td className="mono small">{v.code}</td>
                  <td>{v.type === 'ice_occupy_charger' ? '燃油车占充电位' : v.type}</td>
                  <td className="mono">{v.plate}</td>
                  <td>{v.user_name ? `#${v.user_id} ${v.user_name}` : <span className="small muted">无账号·挂账</span>}</td>
                  <td className="mono small">{v.spot_code ?? '—'}</td>
                  <td>{v.has_valid_reservation ? <Tag cls="gray" label="有" /> : <Tag cls="red" label="无" />}</td>
                  <td className="money">{money(v.fine)}</td>
                  <td className="money">{money(v.deposit_deducted)}</td>
                  <td className="money">{money(v.amount_outstanding)}</td>
                  <td>{v.credit_delta}</td>
                  <td><Tag status={v.status === 'waived' ? 'closed' : v.status === 'collected' ? 'resolved' : v.status === 'deducted' ? 'resolved' : 'open'} /></td>
                  <td className="small muted">{dt(v.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------- 订单追溯 ----------
function OrdersTab() {
  const { data: orders } = useLoader<any[]>('/reservations');
  const [detail, setDetail] = useState<number | null>(null);
  return (
    <div>
      <PageHead title="全部停车服务单" desc="覆盖车位发布、预约、入场、异常、离场、分账的完整事件链，供业主/车主/物业共同追溯" />
      <div className="card">
        <OrderTable orders={orders ?? []} onOpen={setDetail} />
      </div>
      {detail && <ReservationDetailModal id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
