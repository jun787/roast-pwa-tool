import { saveSession, listSessions, deleteSession } from './storage';
import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import './App.css';

/* ===== 可調參數：紅點大小 ===== */
const ACTUAL_DOT_RADIUS = 3;

/* ===== Helpers ===== */
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const secToMMSS = (s) => {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
};
const secToZH = (s) => {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}分${ss.toString().padStart(2, '0')}秒`;
};

/* ===== 在序列上查「首次達到某溫度」的時間（線性插值） ===== */
function timeAtTemp(series, temp, endCapSec) {
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1],
      b = series[i];
    if ((a.bt <= temp && b.bt >= temp) || (a.bt >= temp && b.bt <= temp)) {
      const ratio = (temp - a.bt) / (b.bt - a.bt || 1e-9);
      const t = a.t + Math.max(0, Math.min(1, ratio)) * (b.t - a.t);
      return Math.max(0, Math.min(endCapSec, t));
    }
  }
  return null;
}

// 穩定下降版：三次樣條 ROR（端點固定、尾端貼平）＋ 單調校正（嚴格不回升）
function generateCurveStable({
  tpTime,
  tpTemp,
  fcTime,
  fcTemp, // 只作顯示，這裡不參與 ROR 拟合
  rorStart: rS,
  rorFC: rF,
  dropTemp,
}) {
  const dt = 1;
  const T = Math.max(1, Math.round(fcTime - tpTime)); // 建模長度（秒）
  const delta = dropTemp - tpTemp;                     // 需要的總升溫（°C）
  const Ravg = (60 * delta) / T;                       // 期望平均 ROR（°C/分）

  // --- 三次樣條形狀：R(u) = a u^3 + b u^2 + c u + d, u∈[0,1]
  // 條件：R(0)=rS, R(1)=rF, R'(1)=0（尾端貼平）, ∫0..1 R = Ravg
  // 求解得：
  const a = 12 * Ravg - 8 * rF - 4 * rS;
  const b = -24 * Ravg + 15 * rF + 9 * rS;
  const c = 12 * Ravg - 6 * rF - 6 * rS;
  const d = rS;

  // --- 先按樣條生成 ROR，再做「單調不增」校正，杜絕任何上揚/末端墜落
  const r = new Array(T + 1);
  for (let i = 0; i <= T; i++) {
    const u = i / T;
    const val = a * u * u * u + b * u * u + c * u + d;
    r[i] = Math.max(0, val); // ROR 不為負
  }

  // 單調不增濾波：任何上揚都壓平到前一點
  for (let i = 1; i <= T; i++) {
    if (r[i] > r[i - 1]) r[i] = r[i - 1];
  }

  // 尾端貼平到 rF（避免你說的「末端下墜」或偏離），以 30s 緩降貼合
  const tailClampSec = Math.min(30, T);
  const wantEnd = Math.max(0, rF);
  const endDiff = r[T] - wantEnd;
  if (Math.abs(endDiff) > 1e-6) {
    const startIdx = Math.max(0, T - tailClampSec);
    const span = T - startIdx || 1;
    for (let i = startIdx; i <= T; i++) {
      const w = (i - startIdx) / span; // 0→1
      // 線性把尾段拉到 rF，同時保持不回升
      r[i] = Math.min(r[i], r[T] - endDiff * w);
    }
    // 再次保證單調
    for (let i = startIdx + 1; i <= T; i++) {
      if (r[i] > r[i - 1]) r[i] = r[i - 1];
    }
    // 最終強制終點精準等於 rF
    r[T] = wantEnd;
    if (T >= 1 && r[T] > r[T - 1]) r[T] = r[T - 1];
  }

  // --- 由 ROR 積分出 BT（不做整條平移）
  const pts = [];
  let bt = tpTemp;
  for (let i = 0; i <= T; i++) {
    bt += (r[i] / 60) * dt; // 每秒積分
    pts.push({
      t: tpTime + i,
      bt: Number(bt.toFixed(2)),
      ror: Number(r[i].toFixed(2)),
    });
  }

  // 末點與 dropTemp 的微小誤差（數值累積）用極小幅 BT 微調處理，不動 ROR 形狀
  const lastIdx = pts.length - 1;
  const err = dropTemp - pts[lastIdx].bt;
  if (Math.abs(err) > 0.2) {
    const tail = Math.min(60, T);
    const t0 = fcTime - tail;
    let wsum = 0;
    for (let i = 0; i <= lastIdx; i++) if (pts[i].t >= t0) wsum += (pts[i].t - t0) / tail;
    const perW = wsum ? err / wsum : 0;
    for (let i = 0; i <= lastIdx; i++) if (pts[i].t >= t0) {
      const w = (pts[i].t - t0) / tail;
      pts[i].bt = Number((pts[i].bt + perW * w).toFixed(2));
    }
    // ROR 維持原單調結果，不重新回推（避免破壞「不回升」）
  }

  return pts;
}



export default function App() {
  useEffect(() => {
    document.title = '烘豆參數預測工具';
  }, []);

  // ✅ 放這裡（很前面）
  const [sessions, setSessions] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sessionName, setSessionName] = useState('');
  const drawerRef = useRef(null);

  // ✅ 取代你原本的 2-4：iPhone 左緣滑出 / 抽屜內左滑關閉（安全版）
  useEffect(() => {
    // 只有觸控裝置才啟用（避免桌機環境觸發奇怪事件）
    const isTouch =
      typeof window !== 'undefined' &&
      ('ontouchstart' in window || navigator.maxTouchPoints > 0);

    if (!isTouch) return;

    let startX = null;
    let startY = null;
    let tracking = false;
    let inDrawer = false;

    function onStart(e) {
      // 防呆：事件型態檢查
      const touches = e?.touches;
      if (!touches || touches.length !== 1) return;

      const t = touches[0];
      if (!t) return;

      startX = t.clientX ?? 0;
      startY = t.clientY ?? 0;

      // 左邊緣開始 => 嘗試開啟
      if (!drawerOpen && startX <= 16) {
        tracking = true;
        inDrawer = false;
        return;
      }

      // 抽屜內開始 => 允許左滑關閉（右滑不關）
      if (drawerOpen && drawerRef?.current) {
        const r = drawerRef.current.getBoundingClientRect?.();
        if (r) {
          inDrawer =
            startX >= r.left &&
            startX <= r.right &&
            startY >= r.top &&
            startY <= r.bottom;
          if (inDrawer) {
            tracking = true;
          }
        }
      }
    }

    function onMove(e) {
      if (!tracking || startX == null) return;
      const touches = e?.touches;
      if (!touches || touches.length !== 1) return;

      const t = touches[0];
      if (!t) return;

      const dx = (t.clientX ?? 0) - startX;

      // 開啟：左緣右滑
      if (!drawerOpen && dx > 24) {
        setDrawerOpen(true);
        tracking = false;
        inDrawer = false;
        return;
      }

      // 關閉：抽屜內左滑（右滑不關）
      if (drawerOpen && inDrawer && dx < -24) {
        setDrawerOpen(false);
        tracking = false;
        inDrawer = false;
        return;
      }
    }

    function onEnd() {
      startX = null;
      startY = null;
      tracking = false;
      inDrawer = false;
    }

    // 綁在 window（或 document）皆可，這裡用 window
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });

    // 清理
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
  }, [drawerOpen, drawerRef]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows = await listSessions();
        if (alive) setSessions(Array.isArray(rows) ? rows : []);
      } catch {
        if (alive) setSessions([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* ===== 草稿參數（綁 input） ===== */
  const [tpTime, setTpTime] = useState(60);
  const [tpTemp, setTpTemp] = useState(100);
  const [fcTime, setFcTime] = useState(450); // 總烘焙時間（秒）
  const [fcTemp, setFcTemp] = useState(188); // 一爆溫度（°C）
  const [dropTemp, setDropTemp] = useState(204); // 下豆溫度（°C）
  const [rorStart, setRorStart] = useState(20); // 起始 ROR
  const [rorFC, setRorFC] = useState(10); // 末端 ROR
  const [yellowTemp, setYellowTemp] = useState(145);

  /* ===== 已套用參數（圖表/表格使用）——缺它會整頁炸掉！===== */
  const [applied, setApplied] = useState({
    tpTime: 60,
    tpTemp: 100,
    fcTime: 450, // 總烘焙時間
    fcTemp: 188, // 一爆溫度
    dropTemp: 204, // 下豆溫度
    rorStart: 20,
    rorFC: 10,
    yellowTemp: 145,
  });

  /* 工具：數值夾限 + 一次性提示（按按鈕時才檢查） */
  const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const [applyNote, setApplyNote] = useState('');

  /* 設定：節點（圖表） */
  const [intervalSec, setIntervalSec] = useState(30);

  /* 表格 ROR 單位（min / 30s） */
  const [tableRorUnit, setTableRorUnit] = useState('min');

  /* 實際紅點（只畫在圖上） */
  const [actuals, setActuals] = useState([]); // { t, temp }
  const [actualTimeSec, setActualTimeSec] = useState('');
  const [actualTemp, setActualTemp] = useState('');

  /* 產生/更新曲線（只有按按鈕才更新） */
  const data = useMemo(() => generateCurveStable(applied), [applied]);

  // 只取 TP 之後
  const chartData = useMemo(
    () => data.filter((d) => d.t >= applied.tpTime),
    [data, applied.tpTime]
  );

  // checkpoints (TP → 總時間)
  const checkpoints = useMemo(
    () =>
      chartData.filter((d) => d.t % intervalSec === 0 && d.t <= applied.fcTime),
    [chartData, applied.fcTime, intervalSec]
  );

  // X 軸刻度
  const xTicks = useMemo(() => {
    const arr = [];
    for (let s = applied.tpTime; s <= applied.fcTime; s += intervalSec)
      arr.push(s);
    return arr;
  }, [applied.tpTime, applied.fcTime, intervalSec]);

  // 表格資料
  const tableRows = useMemo(
    () =>
      checkpoints.map((d) => ({
        t: d.t,
        timeLabelZh: secToZH(d.t),
        targetBT: d.bt,
        targetROR: Number(
          (tableRorUnit === 'min' ? d.ror : d.ror / 2).toFixed(1)
        ),
      })),
    [checkpoints, tableRorUnit]
  );

  // 紅點
  const actualDots = useMemo(
    () =>
      [...actuals]
        .sort((a, b) => a.t - b.t)
        .map((x) => ({ t: x.t, actual: x.temp })),
    [actuals]
  );

  // 新增紅點
  const addActual = () => {
    const s = Number(actualTimeSec);
    const T = Number(actualTemp);
    if (!Number.isFinite(s) || !Number.isFinite(T)) return;
    const clamped = clamp(s, applied.tpTime, applied.fcTime);
    const aligned = clamped - (clamped % intervalSec);
    setActuals((prev) => {
      const others = prev.filter((x) => x.t !== aligned);
      return [...others, { t: aligned, temp: T }];
    });
    setActualTimeSec('');
    setActualTemp('');
  };

  const undoActual = () => {
    setActuals((prev) => {
      if (prev.length === 0) return prev;
      const arr = [...prev].sort((a, b) => a.t - b.t);
      arr.pop();
      return arr;
    });
  };
  const clearActuals = () => setActuals([]);

  // 套用參數按鈕（按下才檢查 & 夾限）
  const applyParams = () => {
    const y0 = Math.round(yellowTemp);
    const fc0 = Math.round(fcTemp);
    const dr0 = Math.round(dropTemp);

    let y = clampNum(y0, 120, 170); // 轉黃 120–170（可調）
    let fc = clampNum(fc0, 120, 230); // 一爆 120–230
    let dr = clampNum(dr0, 150, 240); // 下豆 150–240

    const notes = [];
    if (fc <= y) {
      fc = Math.min(230, y + 1);
      notes.push(`一爆溫度自動調為 ${fc}°C（需高於轉黃 ${y}°C）`);
    }
    if (dr < fc) {
      dr = Math.min(240, fc);
      notes.push(`下豆溫度自動調為 ${dr}°C（需不低於一爆 ${fc}°C）`);
    }

    setApplied({
      tpTime,
      tpTemp,
      fcTime, // 總烘焙時間原樣使用
      fcTemp: fc,
      dropTemp: dr,
      rorStart,
      rorFC,
      yellowTemp: y,
    });
    setApplyNote(notes.join('；'));
  };

  // 左側 Y 軸範圍
  const leftMin = useMemo(() => {
    if (!chartData.length) return 80;
    const v = Math.min(...chartData.map((d) => d.bt));
    return Math.floor(v - 10);
  }, [chartData]);
  const leftMax = useMemo(() => {
    if (!chartData.length) return 210;
    const v = Math.max(...chartData.map((d) => d.bt));
    return Math.ceil(v + 10);
  }, [chartData]);

  // 三階段比例（以總烘焙時間為分母）——轉黃溫度即時反映
  const phaseInfo = useMemo(() => {
    const endT = applied.fcTime;
    const tYellow = timeAtTemp(data, yellowTemp, endT) ?? 0;
    const tFC = timeAtTemp(data, applied.fcTemp, endT) ?? endT;

    const dry = Math.max(0, Math.min(endT, tYellow) - 0); // 0 → 轉黃
    const mai = Math.max(0, Math.min(endT, tFC) - Math.min(endT, tYellow)); // 轉黃 → 一爆
    const dev = Math.max(0, endT - Math.min(endT, tFC)); // 一爆 → 下豆

    const sum = Math.max(1, endT);
    return {
      tYellow,
      tFC,
      drySec: Math.round(dry),
      maiSec: Math.round(mai),
      devSec: Math.round(dev),
      dryPct: (dry / sum) * 100,
      maiPct: (mai / sum) * 100,
      devPct: (dev / sum) * 100,
    };
  }, [data, applied.fcTime, applied.fcTemp, yellowTemp]);

  const doSave = async () => {
    try {
      const pack = {
        name: sessionName || `未命名-${new Date().toLocaleString()}`,
        params: applied, // 已套用參數
        actuals, // 紅點
        intervalSec,
        tableRorUnit,
      };
      await saveSession(pack);
      const rows = await listSessions();
      setSessions(Array.isArray(rows) ? rows : []);
      setSessionName('');
    } catch (e) {
      console.error('doSave failed', e);
    }
  };

  const doLoad = (s) => {
    if (!s) return;

    // 1) 取出儲存的參數（若欄位缺就保留現值）
    const p = s.params || applied;

    // 2) 更新「套用後」狀態（圖表/表格用）
    setApplied(p);

    // 3) 同步更新「輸入框」綁定的各個 state，這樣 UI 會顯示載入的值
    setTpTime(p.tpTime ?? tpTime);
    setTpTemp(p.tpTemp ?? tpTemp);
    setFcTime(p.fcTime ?? fcTime);
    setFcTemp(p.fcTemp ?? fcTemp);
    setDropTemp(p.dropTemp ?? dropTemp);
    setRorStart(p.rorStart ?? rorStart);
    setRorFC(p.rorFC ?? rorFC);
    setYellowTemp(p.yellowTemp ?? yellowTemp);

    // 4) 其他一起回填
    setActuals(Array.isArray(s.actuals) ? s.actuals : []);
    setIntervalSec(s.intervalSec ?? 30);
    setTableRorUnit(s.tableRorUnit ?? 'min');

    setDrawerOpen(false);
  };

  const doDelete = async (id) => {
    try {
      await deleteSession(id);
      const rows = await listSessions();
      setSessions(Array.isArray(rows) ? rows : []);
    } catch (e) {
      console.error('delete failed', e);
    }
  };

  const doRename = async (s) => {
    const newName = window.prompt('輸入新名稱', s.name || '');
    if (!newName) return;
    try {
      await saveSession({ ...s, name: newName }); // 直接覆蓋
      const rows = await listSessions();
      setSessions(Array.isArray(rows) ? rows : []);
    } catch (e) {
      console.error('rename failed', e);
    }
  };

  return (
    <div className="page">
      <div className="wrap">
        {/* Title */}
        <div
          className="titleBar"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {drawerOpen && (
            <div
              onClick={() => setDrawerOpen(false)}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.35)',
                zIndex: 40,
              }}
            />
          )}

          <button
            className="btnGhost"
            style={{
              fontSize: '24px',
              padding: '2px 6px',
              width: 'auto', // 👈 不讓它佔滿
              flex: '0 0 auto', // 👈 禁止 flex 拉伸
            }}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            ≡ 紀錄
          </button>

          <h1 style={{ flex: '0 0 auto', textAlign: 'center', margin: 0 }}>
            烘豆參數預測工具
          </h1>
          <div style={{ width: '50px' }} />
        </div>

        {drawerOpen && (
          <div
            ref={drawerRef}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              bottom: 0,
              width: 280,
              background: 'var(--cardBg,#fff)',
              borderRight: '1px solid #e5e7eb',
              boxShadow: '2px 0 8px rgba(0,0,0,.05)',
              padding: 12,
              zIndex: 50,
              overflowY: 'auto',
            }}
          >
            <div
              className="drawerListHeader"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <strong style={{ color: '#000' }}>本機紀錄</strong>
              <button className="btnGhost" onClick={() => setDrawerOpen(false)}>
                關閉
              </button>
            </div>

            <div style={{ marginTop: 12 }} className="drawerListSave">
              <label className="field">
                <div className="label">此次名稱（可選）</div>
                <input
                  className="input"
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                  placeholder="例如 0920 哥倫比亞 300g"
                />
              </label>
              {/* 這顆先呼叫一個保底的 doSave（下一段我給） */}
              <button
                className="btnPrimary"
                onClick={doSave}
                style={{ marginTop: 8, width: '100%' }}
              >
                儲存本次
              </button>
            </div>

            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--muted)' }}>
              清單
            </div>
            <div
              style={{
                marginTop: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div className="drawerList" style={{ marginTop: 8 }}>
                {(Array.isArray(sessions) ? sessions : []).map((s) => (
                  <div
                    key={s.id || s.updatedAt || Math.random()}
                    className="card listCard" // ← 多加 listCard
                    style={{ padding: 10, cursor: 'pointer' }} // 你原本有 padding 就保留
                    role="button"
                    tabIndex={0}
                    onClick={() => doLoad(s)}
                  >
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {s.name || '未命名'}
                    </div>
                    <div className="listMeta">
                      {(s.updatedAt &&
                        new Date(s.updatedAt).toLocaleString()) ||
                        '—'}
                    </div>

                    <div className="listActions">
                      {' '}
                      {/* ← 用 listActions 控制行距 */}
                      <button
                        className="btnPrimary btnSm" // ← 小號主按鈕
                        onClick={(e) => {
                          e.stopPropagation();
                          doLoad(s);
                        }}
                      >
                        載入
                      </button>
                      <button
                        className="btnGhost btnSm" // ← 小號次要按鈕
                        onClick={(e) => {
                          e.stopPropagation();
                          doDelete(s.id);
                        }}
                      >
                        刪除
                      </button>
                      <button
                        className="btnGhost btnSm" // ← 小圖示鈕（32x32）
                        onClick={(e) => {
                          e.stopPropagation();
                          doRename(s);
                        }}
                        title="重新命名"
                      >
                        ✎
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {(!sessions || sessions.length === 0) && (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  尚無紀錄
                </div>
              )}
            </div>
          </div>
        )}

        {/* 參數輸入 */}
        <div className="grid">
          <Field label="回溫點時間（秒）" value={tpTime} onChange={setTpTime} />
          <Field label="回溫點溫度（°C）" value={tpTemp} onChange={setTpTemp} />
          <Field label="總烘焙時間（秒）" value={fcTime} onChange={setFcTime} />
          <Field label="一爆溫度（°C）" value={fcTemp} onChange={setFcTemp} />
          <Field
            label="轉黃溫度（°C）"
            value={yellowTemp}
            onChange={setYellowTemp}
          />
          <Field
            label="下豆溫度（°C）"
            value={dropTemp}
            onChange={setDropTemp}
          />
          <Field
            label="初始 ROR（°C/分）"
            value={rorStart}
            onChange={setRorStart}
          />
          <div>
            <Field
              label="末端 ROR（°C/分）"
              value={rorFC}
              onChange={setRorFC}
            />
            <button
              className="btnPrimary"
              style={{ marginTop: 8 }}
              onClick={applyParams}
            >
              產生預測曲線表格
            </button>
            {applyNote && (
              <div
                style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}
              >
                {applyNote}
              </div>
            )}
          </div>
        </div>

        {/* 控制列 */}
        <div className="controls">
          <label className="labelRow">
            節點：
            <select
              className="select"
              value={intervalSec}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
            >
              <option value={30}>每 30 秒</option>
              <option value={60}>每 60 秒</option>
            </select>
          </label>

          <label className="labelRow">
            表格 ROR 單位：
            <select
              className="select"
              value={tableRorUnit}
              onChange={(e) => setTableRorUnit(e.target.value)}
            >
              <option value="min">每分鐘（°C/分）</option>
              <option value="30s">每 30 秒（°C/30秒）</option>
            </select>
          </label>
        </div>

        {/* 三階段比例長條 */}
        <div className="card">
          <div className="cardTitle">三階段時間比例</div>
          <div
            style={{
              display: 'flex',
              height: 16,
              borderRadius: 8,
              overflow: 'hidden',
              border: '1px solid var(--border, #e5e7eb)',
            }}
            title={`脫水 ${secToZH(phaseInfo.drySec)} | 梅納 ${secToZH(
              phaseInfo.maiSec
            )} | 發展 ${secToZH(phaseInfo.devSec)}`}
          >
            <div
              style={{ width: `${phaseInfo.dryPct}%`, background: '#c8ebff' }}
            />
            <div
              style={{ width: `${phaseInfo.maiPct}%`, background: '#fff2b3' }}
            />
            <div
              style={{ width: `${phaseInfo.devPct}%`, background: '#f3f4f6' }}
            />
          </div>
          <div
            style={{
              display: 'flex',
              gap: 12,
              marginTop: 6,
              fontSize: 12,
              color: 'var(--muted)',
            }}
          >
            <span>
              <i
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  background: '#c8ebff',
                  border: '1px solid #cbd5e1',
                  marginRight: 6,
                }}
              />
              脫水 {secToZH(phaseInfo.drySec)} ({phaseInfo.dryPct.toFixed(1)}%)
            </span>
            <span>
              <i
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  background: '#fff2b3',
                  border: '1px solid #cbd5e1',
                  marginRight: 6,
                }}
              />
              梅納 {secToZH(phaseInfo.maiSec)} ({phaseInfo.maiPct.toFixed(1)}%)
            </span>
            <span>
              <i
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  background: '#f3f4f6',
                  border: '1px solid #cbd5e1',
                  marginRight: 6,
                }}
              />
              發展 {secToZH(phaseInfo.devSec)} ({phaseInfo.devPct.toFixed(1)}%)
            </span>
          </div>
        </div>

        {/* 實際點輸入 */}
        <div className="card">
          <div className="gridThree">
            <SmallField
              label="實際時間（秒）"
              value={actualTimeSec}
              onChange={setActualTimeSec}
              placeholder="例如 180"
            />
            <SmallField
              label="實際溫度（°C）"
              value={actualTemp}
              onChange={setActualTemp}
              placeholder="例如 145.3"
            />
            <div
              className="flexRow"
              style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
            >
              <button className="btnPrimary" onClick={addActual}>
                加入實際點（紅色）
              </button>
              <button className="btnGhost" onClick={undoActual}>
                撤銷上一個
              </button>
              <button className="btnGhost" onClick={clearActuals}>
                清除全部紅點
              </button>
            </div>
          </div>
        </div>

        {/* 圖表 */}
        <div className="card">
          <div className="cardTitle">預測溫度曲線視覺對照</div>
          <ResponsiveContainer width="110%" height={330}>
            <LineChart
              data={chartData}
              margin={{ top: 10, right: 15, left: -33, bottom: 0 }}
            >
              <XAxis
                type="number"
                dataKey="t"
                domain={[applied.tpTime, applied.fcTime]}
                ticks={xTicks}
                tickFormatter={secToMMSS}
                minTickGap={10}
                tick={{ fontSize: 12, fill: 'var(--muted)' }}
                axisLine={{ stroke: 'var(--muted)' }}
                tickLine={{ stroke: 'var(--muted)' }}
              />
              <YAxis
                yAxisId="left"
                domain={[leftMin, leftMax]}
                tick={{ fontSize: 12, fill: 'var(--muted)' }}
                axisLine={{ stroke: 'var(--muted)' }}
                tickLine={{ stroke: 'var(--muted)' }}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={[0, Math.max(24, applied.rorStart + 4)]}
                tick={{ fontSize: 12, fill: 'var(--muted)' }}
                axisLine={{ stroke: 'var(--muted)' }}
                tickLine={{ stroke: 'var(--muted)' }}
              />
              <Tooltip
                labelFormatter={(value) => secToMMSS(value)}
                contentStyle={{
                  background: 'var(--tooltipBg)',
                  border: '1px solid var(--tooltipBorder)',
                  color: 'var(--fg)',
                }}
                formatter={(v, name) => [v, name]}
              />
              <Legend wrapperStyle={{ color: 'var(--muted)' }} />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="bt"
                name="預測溫度"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="ror"
                name="預測ROR"
                stroke="#60a5fa"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              {actualDots.length > 0 && (
                <Line
                  yAxisId="left"
                  data={actualDots}
                  dataKey="actual"
                  name="實際溫度"
                  stroke="transparent"
                  dot={{
                    r: ACTUAL_DOT_RADIUS,
                    stroke: '#ef4444',
                    fill: '#ef4444',
                  }}
                  isAnimationActive={false}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* 目標表 */}
        <div className="tableCard">
          <div className="tableHeader">
            {intervalSec === 30 ? '每 30 秒' : '每 60 秒'} 目標表
          </div>
          <div className="tableWrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="th">時間</th>
                  <th className="th">目標溫度（°C）</th>
                  <th className="th">
                    目標升溫速率（{tableRorUnit === 'min' ? '°C/分' : '°C/30秒'}
                    ）
                  </th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r, idx) => (
                  <tr key={r.t} className={idx % 2 ? 'tr zebra' : 'tr'}>
                    <td className="td td-time">{r.timeLabelZh}</td>
                    <td className="td td-temp">{r.targetBT.toFixed(1)}</td>
                    <td className="td td-ror">{r.targetROR.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===== Tiny inputs ===== */
function Field({ label, value, onChange }) {
  return (
    <label className="field">
      <div className="label">{label}</div>
      <input
        type="number"
        className="input"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
function SmallField({ label, value, onChange, placeholder }) {
  return (
    <label className="field">
      <div className="label">{label}</div>
      <input
        type="number"
        className="input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
