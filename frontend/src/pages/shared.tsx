import { useEffect, useState } from 'react';
import { api } from '../api';
import { AdjudicationPanel, EvidenceList, LedgerTable, ServiceEvents, SettlementView, TimelineView } from '../components';
import { dt, DISPOSITION_LABEL, INCIDENT_LABEL, money, Modal, RulingTag, Tag } from '../ui';

// 订单全链路追溯弹层：预约信息 + 事件流 + 异常工单 + 申诉 + 分账 + 同车位时间轴入口
export function ReservationDetailModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'trace' | 'settlement' | 'timeline'>('trace');
  const [timeline, setTimeline] = useState<any>(null);

  useEffect(() => {
    api('GET', `/reservations/${id}`).then(setD).catch((e) => setErr(e.message));
  }, []);

  if (err) return <Modal title="订单详情" onClose={onClose}><div className="alert error">{err}</div></Modal>;
  if (!d) return <Modal title="加载中…" onClose={onClose}><div className="empty">加载中…</div></Modal>;

  const loadTimeline = async () => {
    if (timeline) { setTab('timeline'); return; }
    const t = await api('GET', `/spots/${d.spot_id}/timeline`);
    setTimeline(t);
    setTab('timeline');
  };

  return (
    <Modal
      wide
      title={
        <div className="btn-row" style={{ justifyContent: 'space-between', width: '100%', paddingRight: 12 }}>
          <span>停车服务单 {d.code}</span>
          <span className="btn-row">
            <Tag status={d.status} />
            {d.priority === 'monthly' && <Tag status="monthly" />}
            <RulingTag ruling={d.settlement?.ruling} />
          </span>
        </div>
      }
      onClose={onClose}
    >
      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Info label="车位" value={`${d.community_name} · ${d.spot_code}`} />
        <Info label="车牌" value={d.plate} mono />
        <Info label="车主" value={d.driver_name} />
        <Info label="业主" value={d.owner_name} />
        <Info label="预约时段" value={`${dt(d.start_at)}\n~ ${dt(d.end_at)}`} pre />
        <Info label="入场道闸" value={d.gate_entry_at ? dt(d.gate_entry_at) : '—'} />
        <Info label="停放确认" value={d.parking_confirmed_at ? dt(d.parking_confirmed_at) : '—'} />
        <Info label="离场结算" value={d.settled_at ? dt(d.settled_at) : '—'} />
      </div>

      <div className="btn-row" style={{ marginBottom: 14 }}>
        <button className={`btn sm ${tab === 'trace' ? '' : 'gray'}`} onClick={() => setTab('trace')}>全链路事件 ({d.events.length})</button>
        <button className={`btn sm ${tab === 'settlement' ? '' : 'gray'}`} onClick={() => setTab('settlement')}>
          分账清算 {d.settlement ? money(d.settlement.payable) : '（未结算）'}
        </button>
        <button className={`btn sm ${tab === 'timeline' ? '' : 'gray'}`} onClick={loadTimeline}>同车位当晚时间轴</button>
        <span style={{ flex: 1 }} />
        <span className="small muted">异常工单 {d.incidents.length} · 申诉 {d.appeals.length}</span>
      </div>

      {tab === 'trace' && (
        <div className="grid grid-2">
          <div>
            <h3 style={{ fontSize: 14, marginBottom: 8 }}>同一笔停车服务事件流</h3>
            <ServiceEvents events={d.events} />
          </div>
          <div>
            <h3 style={{ fontSize: 14, marginBottom: 8 }}>夜间异常与挪车通知</h3>
            {d.incidents.length === 0 && <div className="empty">本单无异常工单</div>}
            {d.incidents.map((t: any) => (
              <div key={t.id} className={`ticket-card ${t.status}`}>
                <div className="ticket-head">
                  <span className="ticket-title">{INCIDENT_LABEL[t.type] ?? t.type}</span>
                  <Tag status={t.status} />
                </div>
                <div className="ticket-desc">{t.description}</div>
                {t.resolution && <div className="small">处置：{t.resolution}</div>}
              </div>
            ))}
            <h3 style={{ fontSize: 14, margin: '14px 0 8px' }}>错停申诉</h3>
            {d.appeals.length === 0 && <div className="empty">本单无申诉</div>}
            {d.appeals.map((a: any) => (
              <div key={a.id} className="ticket-card investigating">
                <div className="ticket-head">
                  <span className="ticket-title">{a.code}</span>
                  <RulingTag ruling={a.ruling} />
                </div>
                <div className="ticket-desc">{a.reason}</div>
                <div className="small muted">{a.ruling_note ?? '调查中，等待物业终裁'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'settlement' && (
        d.settlement ? <SettlementWithLedger id={d.id} /> : <div className="empty">订单尚未离场结算</div>
      )}

      {tab === 'timeline' && (timeline ? <TimelineView data={timeline} /> : <div className="empty">加载中…</div>)}
    </Modal>
  );
}

function SettlementWithLedger({ id }: { id: number }) {
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    api('GET', `/reservations/${id}/settlement`).then((r) => setS(r ? { ...r, ledger: r.ledger ?? [] } : null));
  }, []);
  if (!s) return <div className="empty">加载中…</div>;
  return (
    <div>
      <SettlementView s={s} />
      {!s.ledger?.length && <LedgerTable entries={s.ledger} />}
    </div>
  );
}

function Info({ label, value, mono, pre }: { label: string; value: any; mono?: boolean; pre?: boolean }) {
  return (
    <div>
      <div className="small muted">{label}</div>
      <div style={{ whiteSpace: pre ? 'pre-line' : undefined }} className={mono ? 'mono' : ''}>{value}</div>
    </div>
  );
}

// 申诉详情（裁决工作台共用）
export function AppealDetailModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged?: () => void }) {
  const [d, setD] = useState<any>(null);
  const [ruling, setRuling] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const reload = () =>
    api('GET', `/appeals/${id}`).then((x) => {
      setD(x);
      setRuling(x.adjudication?.ruling ?? '');
    });

  useEffect(() => {
    reload().catch((e) => setErr(e.message));
  }, []);

  if (err) return <Modal title="申诉详情" onClose={onClose}><div className="alert error">{err}</div></Modal>;
  if (!d) return <Modal title="加载中…" onClose={onClose}><div className="empty">加载中…</div></Modal>;

  const submitRule = async () => {
    setErr(''); setMsg('');
    try {
      await api('POST', `/appeals/${id}/rule`, { ruling, note });
      setMsg('终裁已提交，可在结算页重算分账');
      onChanged?.();
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const resettle = async () => {
    setErr('');
    try {
      await api('POST', `/appeals/${id}/resettle`, {});
      setMsg('分账已按终裁结果重算，信用分已冲销调整');
      onChanged?.();
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <Modal wide title={<span>错停申诉裁决 · {d.code} <RulingTag ruling={d.ruling} /></span>} onClose={onClose}>
      <div className="grid grid-2">
        <div>
          <div className="card" style={{ marginTop: 0 }}>
            <h3>申诉内容</h3>
            <div className="small muted">{d.appellant_name} · {d.plate} · 车位 {d.spot_code} · {dt(d.created_at)}</div>
            {d.appeal_type === 'ice_charger' && (
              <div className="spot-tags" style={{ margin: '8px 0' }}>
                <Tag cls="purple" label="⚡ 燃油车占充电位" />
                <Tag cls="cyan" label={`充电桩 ${d.charger_code ?? '—'}`} />
                <Tag cls="gray" label={`到达 ${dt(d.arrival_at)}`} />
                {d.occupier_plate && <Tag cls="red" label={`占用车 ${d.occupier_plate}`} />}
                {d.disposition && <Tag cls="green" label={`物业已处置：${DISPOSITION_LABEL[d.disposition] ?? d.disposition}`} />}
              </div>
            )}
            <p>{d.reason}</p>
            {d.disposition_note && <div className="alert info">物业处置说明：{d.disposition_note}</div>}
            {d.ruling_note && <div className="alert info">终裁说明：{d.ruling_note}</div>}
          </div>
          <div className="card">
            <h3>证据链 <span className="hint">车牌识别 / 预约 / 照片 / 道闸日志 / 业主回家 / 巡查 / 充电桩编号 / 入场记录</span></h3>
            <EvidenceList items={d.evidence} />
          </div>
        </div>
        <div>
          <div className="card" style={{ marginTop: 0 }}>
            <h3>自动责任分析</h3>
            <AdjudicationPanel a={d.adjudication} />
          </div>
          {d.appeal_type === 'ice_charger' && (
            <IceDispositionCard d={d} setErr={setErr} setMsg={setMsg} onChanged={() => { onChanged?.(); reload(); }} />
          )}
          <div className="card">
            <h3>人工终裁</h3>
            {msg && <div className="alert ok">{msg}</div>}
            {err && <div className="alert error">{err}</div>}
            {d.status === 'closed' ? (
              <div>
                <div className="alert info">该申诉已终裁：<RulingTag ruling={d.ruling} /></div>
                <button className="btn" onClick={resettle}>按终裁结果重算离场分账与信用分</button>
              </div>
            ) : (
              <div>
                <div className="field">
                  <label>裁决结论（默认采纳系统建议）</label>
                  <select value={ruling} onChange={(e) => setRuling(e.target.value)}>
                    <option value="driver_fault">车主责任（违约金 + 信用 -10）</option>
                    <option value="owner_fault">业主责任（补偿车主 + 业主信用 -5）</option>
                    <option value="property_fault">物业责任（赔付券 + 物业信用 -5）</option>
                    <option value="platform_fault">平台责任（免单/赔付券）</option>
                    <option value="stranger">陌生车主责任（平台兜底，向其追缴）</option>
                    <option value="mixed">混合责任（车主信用 -5）</option>
                    <option value="no_fault">无责/证据不足</option>
                  </select>
                </div>
                <div className="field">
                  <label>裁决说明</label>
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="说明证据采信与责任划分依据" />
                </div>
                <button className="btn danger" onClick={submitRule}>提交终裁</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// 充电位错占：物业接单处置（联系挪车 / 安排替代充电桩 / 免除预约费用）+ 终裁后执行燃油车违约
function IceDispositionCard({ d, setErr, setMsg, onChanged }: { d: any; setErr: (s: string) => void; setMsg: (s: string) => void; onChanged: () => void }) {
  const [spots, setSpots] = useState<any[] | null>(null);
  const [altSpot, setAltSpot] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('GET', '/spots').then(setSpots).catch(() => setSpots([]));
  }, []);

  const doDisposition = async (disposition: string) => {
    setErr(''); setMsg(''); setBusy(true);
    try {
      await api('POST', `/appeals/${d.id}/disposition`, {
        disposition,
        note: note || undefined,
        alternate_spot_id: disposition === 'alternate_charger' && altSpot ? Number(altSpot) : undefined,
      });
      setMsg(`已处置：${DISPOSITION_LABEL[disposition]}`);
      onChanged();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const enforce = async () => {
    setErr(''); setMsg(''); setBusy(true);
    try {
      const r = await api('POST', `/appeals/${d.id}/enforce-violation`, {});
      if (r.skipped) { setMsg('占用车辆持有效预约，系统判定不构成燃油车违约，转排期/引导归责'); }
      else {
        setMsg(`违约已执行${r.identified ? '（已锁定车主账号）' : '（未匹配账号，按车牌挂账追缴）'}：违约金 ¥${r.violation.fine}，押金没收 ¥${r.violation.deposit_deducted}，挂账 ¥${r.violation.receivable}`);
      }
      onChanged();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <h3>物业接单处置 <span className="hint">充电位错占</span></h3>
      <div className="small muted" style={{ marginBottom: 8 }}>
        平台已自动调取占用车辆入场记录并推送工单。可选择联系挪车、安排替代充电桩或免除本次预约费用；
        终裁为陌生车主责任后，对无有效预约的燃油车执行违约（违约金/押金没收/挂账追缴/信用与预约权限）。
      </div>
      <div className="field">
        <label>替代充电桩车位（安排替代桩时选择）</label>
        <select value={altSpot} onChange={(e) => setAltSpot(e.target.value ? Number(e.target.value) : '')}>
          <option value="">请选择相邻空闲充电位</option>
          {(spots ?? []).filter((s: any) => s.near_charger && s.id !== d.spot_id).map((s: any) => (
            <option key={s.id} value={s.id}>{s.community_name} · {s.code}（{s.location_desc}）</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>处置备注</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：已电话联系车主，15 分钟内挪车" />
      </div>
      <div className="btn-row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" disabled={busy} onClick={() => doDisposition('move_notice')}>📨 联系挪车</button>
        <button className="btn ghost" disabled={busy || !altSpot} onClick={() => doDisposition('alternate_charger')}>⚡ 安排替代充电桩</button>
        <button className="btn gray" disabled={busy} onClick={() => doDisposition('waive_fee')}>💰 免除预约费用</button>
      </div>
      {d.status === 'closed' && d.ruling === 'stranger' && (
        <div style={{ marginTop: 12, borderTop: '1px dashed var(--ink-3)', paddingTop: 10 }}>
          <div className="small muted" style={{ marginBottom: 6 }}>已终裁为陌生燃油车主责任，可执行违约扣罚（离场结算据此计算补电补偿的追缴冲抵）</div>
          <button className="btn danger" disabled={busy} onClick={enforce}>⚖️ 执行燃油车违约（违约金/押金/权限）</button>
        </div>
      )}
    </div>
  );
}
