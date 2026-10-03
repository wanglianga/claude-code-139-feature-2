import { useState } from 'react';
import { api, clearSession, getSession, setSession } from './api';
import { CreditChip } from './ui';
import { OwnerWorkspace } from './pages/owner';
import { DriverWorkspace } from './pages/driver';
import { PropertyWorkspace } from './pages/property';
import { AdminWorkspace } from './pages/admin';

const ROLE_LABEL = { owner: '业主', driver: '外来车主', property: '物业', admin: '平台管理员' } as const;

export function App() {
  const [session, setSessionState] = useState(getSession());

  if (!session) return <Login onLogin={(s) => setSessionState(s)} />;

  switch (session.user.role) {
    case 'owner':
      return <OwnerWorkspace session={session} />;
    case 'driver':
      return <DriverWorkspace session={session} />;
    case 'property':
      return <PropertyWorkspace session={session} />;
    case 'admin':
      return <AdminWorkspace session={session} />;
    default:
      return null;
  }
}

function Login({ onLogin }: { onLogin: (s: any) => void }) {
  const [username, setUsername] = useState('owner1');
  const [password, setPassword] = useState('Pass1234');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (u?: string) => {
    setErr('');
    setLoading(true);
    try {
      const name = u ?? username;
      setUsername(name);
      const res = await api('POST', '/auth/login', { username: name, password });
      setSession(res);
      onLogin(res);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  const accounts = [
    { u: 'owner1', label: '业主 王业主', desc: '发布车位 · 临时回家' },
    { u: 'driver1', label: '车主 陈车主', desc: '新能源月租 · 充电位错占申诉' },
    { u: 'driver2', label: '访客 赵访客', desc: '访客车辆 · 超时/错停' },
    { u: 'driver3', label: '燃油车 孙燃油', desc: '占位违约 · 押金/预约权限' },
    { u: 'property1', label: '物业 小周', desc: '审核 · 调度 · 接单处置 · 裁决' },
    { u: 'admin1', label: '管理员', desc: '分账监管 · 发券' },
  ];

  return (
    <div className="login-wrap">
      <div className="login-hero">
        <h1>社区共享停车<br />错停申诉 · 收益分账 · 夜间调度平台</h1>
        <div className="sub">
          车位发布、预约、入场道闸车牌识别、导航引导、计费离场全链路绑定同一笔停车服务；
          以证据链裁决错停责任，按业主 / 物业 / 平台 70·10·20 合并清算，支持三方共同追溯。
        </div>
        <div className="hero-points">
          <div className="hero-point"><b>🅿️ 车位发布审核</b>产权、共享时段、充电桩、访客与月租优先规则</div>
          <div className="hero-point"><b>🚧 夜间调度</b>业主回家、超时、陌生占用、识别失败、燃油车占充电位</div>
          <div className="hero-point"><b>⚖️ 错停申诉</b>六类证据自动汇聚，责任建议 + 人工终裁</div>
          <div className="hero-point"><b>💰 收益分账</b>业主收益/物业费/平台抽成/券/退款/补偿合并清算</div>
        </div>
      </div>
      <div className="login-panel">
        <div className="login-card">
          <h2>登录</h2>
          <div className="tip">使用测试账号一键进入对应角色工作台</div>
          {err && <div className="alert error">{err}</div>}
          <div className="field">
            <label>用户名</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="field">
            <label>密码</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </div>
          <button className="btn" style={{ width: '100%' }} disabled={loading} onClick={() => submit()}>
            {loading ? '登录中…' : '登 录'}
          </button>
          <div style={{ height: 20 }} />
          <div className="small muted" style={{ marginBottom: 8 }}>测试账号（密码均为 Pass1234）：</div>
          <div className="grid" style={{ gap: 8 }}>
            {accounts.map((a) => (
              <button
                key={a.u}
                className="btn gray sm"
                style={{ justifyContent: 'flex-start', padding: '9px 12px' }}
                onClick={() => submit(a.u)}
              >
                <span>
                  <b style={{ fontWeight: 600 }}>{a.label}</b>
                  <span className="muted"> · {a.desc}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// 工作台通用外壳：左侧导航 + 顶部用户条
export function WorkspaceShell({
  session,
  nav,
  active,
  onNav,
  children,
}: {
  session: NonNullable<ReturnType<typeof getSession>>;
  nav: { key: string; label: string; icon: string }[];
  active: string;
  onNav: (k: string) => void;
  children: React.ReactNode;
}) {
  const [, force] = useState(0);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="logo">
          社区共享停车
          <small>错停申诉 · 收益分账 · 夜间调度</small>
        </div>
        <div style={{ padding: '4px 10px 12px' }}>
          <span className="tag blue">{ROLE_LABEL[session.user.role]}工作台</span>
        </div>
        {nav.map((n) => (
          <button key={n.key} className={`nav-item ${active === n.key ? 'active' : ''}`} onClick={() => onNav(n.key)}>
            <span>{n.icon}</span>
            <span>{n.label}</span>
          </button>
        ))}
        <div className="spacer" />
        <div className="userbox">
          <div className="name">{session.user.name}</div>
          <div className="meta" style={{ marginTop: 4 }}>
            <CreditChip score={session.user.creditScore} />
          </div>
        </div>
        <button className="logout" onClick={() => { clearSession(); force((x) => x + 1); location.reload(); }}>
          退出登录
        </button>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
