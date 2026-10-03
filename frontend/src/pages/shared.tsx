import { useEffect, useState } from 'react';
import { api } from '../api';
import { AdjudicationPanel, EvidenceList, LedgerTable, ServiceEvents, SettlementView, TimelineView } from '../components';
import { dt, INCIDENT_LABEL, money, Modal, RulingTag, Tag } from '../ui';

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
      setRuling((r) => r || x.adjudication?.ruling || '');
    });

  useEffect(() => {
    reload().catch((e) => setErr(e.message));
  }, []);

  if (err) return <Modal title="申诉详情" onClose={onClose}><div className="alert error">{err}</div></Modal>;
  if (!d) return <Modal title="加载中…" onClose={onClose}><div className="empty">加载中…</div></Modal>;

  const submitRule = async () => {
    setErr(''); setMsg('');
    try {
      const r = await api('POST', `/appeals/${id}/rule`, { ruling, note });
      setMsg(r.violation ? `终裁已提交；占位燃油车无有效预约，已登记违约（罚金/押金/信用/挂账追缴）` : '终裁已提交，可在结算页重算分账');
      onChanged?.();
      await reload();
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
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <Modal wide title={<span>{d.appeal_type === 'charging_occupy' ? '⚡ 充电车位错占申诉裁决' : '错停申诉裁决'} · {d.code} <RulingTag ruling={d.ruling} /></span>} onClose={onClose}>
      <div className="grid grid-2">
        <div>
          <div className="card" style={{ marginTop: 0 }}>
            <h3>申诉内容</h3>
            <div className="small muted">{d.appellant_name} · {d.plate} · 车位 {d.spot_code} · {dt(d.created_at)}</div>
            <p>{d.reason}</p>
            {d.appeal_type === 'charging_occupy' && <ChargingAppealInfo d={d} />}
            {d.ruling_note && <div className="alert info">终裁说明：{d.ruling_note}</div>}
          </div>
          <div className="card">
            <h3>证据链 <span className="hint">入场记录 / 现场照片 / 预约 / 巡查 …</span></h3>
            <EvidenceList items={d.evidence} />
          </div>
          {d.violations?.length > 0 && (
            <div className="card">
              <h3>违约记录（占位燃油车）</h3>
              {d.violations.map((v: any) => (
                <div key={v.id} className="ticket-card open">
                  <div className="ticket-head">
                    <span className="ticket-title mono">{v.plate}</span>
                    <span className="btn-row">
                      <Tag cls={v.has_valid_reservation ? 'gray' : 'red'} label={v.has_valid_reservation ? '有预约·待核查' : '无有效预约'} />
                      <Tag status={v.status === 'waived' ? 'closed' : 'resolved'} />
                    </span>
                  </div>
                  <div className="ticket-desc">{v.description}</div>
                  <div className="small muted">
                    违约金 ¥{v.fine} · 押金抵扣 ¥{v.deposit_deducted} · 挂账追缴 ¥{v.amount_outstanding} · 信用 {v.credit_delta}
                    {v.user_id ? ` · 已落账车主 #${v.user_id}` : ' · 系统无该车牌账号，挂账追缴'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          {d.appeal_type === 'charging_occupy' && <ChargingHandlePanel d={d} onAction={async () => { setMsg('物业处置已记录'); await reload(); onChanged?.(); }} />}
          <div className="card" style={{ marginTop: 0 }}>
            <h3>自动责任分析</h3>
            <AdjudicationPanel a={d.adjudication} />
          </div>
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
                    <option value="stranger">陌生/占位车主责任（平台兜底，向其追缴；无有效预约记违约）</option>
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

// 充电位错占：现场三要素 + 系统调取的入场记录 + 补电补偿试算
function ChargingAppealInfo({ d }: { d: any }) {
  const entry = d.occupying_entry;
  const rc = d.recharge_preview;
  return (
    <div className="alert info" style={{ marginTop: 10 }}>
      <div className="spot-tags">
        <Tag cls="purple" label={`充电桩 ${d.charger_code}`} />
        <Tag cls="cyan" label={`到达 ${dt(d.arrived_at)}`} />
        <Tag cls="red" label={`占位燃油车 ${d.occupying_plate}`} />
        {d.alt_charger_code && <Tag cls="green" label={`替代桩 ${d.alt_charger_code}`} />}
      </div>
      <div style={{ marginTop: 8 }}>
        <b>占用车辆入场记录（系统自动调取）：</b>
        {entry?.entry ? (
          <span>{entry.entry.gate} · {dt(entry.entry.occurred_at)} · {
            entry.entry.type === 'manual_release' ? '物业人工放行'
              : entry.entry.type === 'recognition_fail' ? '识别无匹配/疑似跟车入场（留有影像）'
                : '车牌识别放行'}
            {entry.validReservation
              ? ' · 该车存在有效预约（转人工核查，不直接记违约）'
              : ' · 该车无有效预约（终裁成立即登记违约）'}
          </span>
        ) : <span>未检索到任何道闸事件（疑似跟车入场），无有效预约，物业需核查人工/跟车通道。</span>}
      </div>
      {rc && (
        <div style={{ marginTop: 8 }}>
          <b>补电补偿：</b>期望 {d.requested_kwh}kWh / 实际 {rc.kwhGap ? Math.max(0, Number(d.requested_kwh) - rc.kwhGap) : d.requested_kwh}kWh
          ，未充满缺口 <b>{rc.kwhGap}kWh</b>，离场结算补偿 <b>{money(rc.compensation)}</b>
          <div className="small muted">{(rc.notes ?? []).join('；')}</div>
        </div>
      )}
    </div>
  );
}

// 物业接单处置：联系挪车 / 安排替代充电桩 / 免除预约费
function ChargingHandlePanel({ d, onAction }: { d: any; onAction: () => void }) {
  const [altCharger, setAltCharger] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const actions: any[] = d.property_actions ?? [];
  const done = (a: string) => actions.some((x) => x.action === a);

  const handle = async (action: string) => {
    setErr(''); setBusy(true);
    try {
      if (action === 'alternative_charger' && !altCharger.trim()) { setErr('请填写替代充电桩编号'); setBusy(false); return; }
      await api('POST', `/appeals/${d.id}/handle`, {
        action,
        alt_charger_code: action === 'alternative_charger' ? altCharger : undefined,
        note: note || undefined,
      });
      setNote('');
      onAction();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const ACTION_LABEL: Record<string, string> = {
    contact_move: '联系燃油车主挪车',
    alternative_charger: '安排替代充电桩',
    waive_fee: '免除本次预约费用',
  };

  return (
    <div className="card">
      <h3>物业接单处置 <span className="hint">可多项叠加</span></h3>
      {err && <div className="alert error">{err}</div>}
      {actions.length > 0 && (
        <div className="small" style={{ marginBottom: 8 }}>
          已处置：{actions.map((a) => `${ACTION_LABEL[a.action]}${a.alt_charger_code ? `（${a.alt_charger_code}）` : ''}`).join('、')}
        </div>
      )}
      <div className="btn-row">
        <button className="btn sm" disabled={busy || done('contact_move')} onClick={() => handle('contact_move')}>📞 联系挪车（App+LED 通知）</button>
        <button className="btn sm success" disabled={busy || done('alternative_charger')} onClick={() => handle('alternative_charger')}>⚡ 安排替代充电桩</button>
        <button className="btn sm gray" disabled={busy || done('waive_fee')} onClick={() => handle('waive_fee')}>💰 免除预约费</button>
      </div>
      {!done('alternative_charger') && (
        <div className="field" style={{ marginTop: 8 }}>
          <label>替代充电桩编号</label>
          <input value={altCharger} onChange={(e) => setAltCharger(e.target.value)} placeholder="如 CP-B2-110-1（相邻空闲充电位）" />
        </div>
      )}
      <div className="field"><label>处置备注</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="如 10 分钟内车主挪车 / 已引导至替代桩" />
      </div>
      <div className="small muted">
        终裁占位车主责任且其无有效预约时：违约金 ¥200 优先扣押金、不足挂账追缴，信用 -10；
        有未结清欠款或信用低于 60 将冻结后续预约，有占位违约史的再次预约需 ¥200 押金。
      </div>
    </div>
  );
}
