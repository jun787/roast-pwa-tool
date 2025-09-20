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

// 單調指數族（端點正確、整段單調、以「離散平均」解參數使積分命中 drop）+ btExact 同步
function generateCurveStable({
  tpTime,
  tpTemp,
  fcTime,
  fcTemp, // 僅顯示，不參與求解
  rorStart: rS,
  rorFC: rF,
  dropTemp,
}) {
  const T = Math.max(1, Math.round(fcTime - tpTime)); // 建模長度（秒）
  const delta = dropTemp - tpTemp; // 需要的總升溫（°C）
  const Ravg = (60 * delta) / T; // 期望平均 ROR（°C/分）
  const span = rS - rF;
  const A = span === 0 ? 0.5 : (Ravg - rF) / span; // 目標離散平均係數，理想在 (0,1)

  // E(u) = (e^{-k u} - e^{-k}) / (1 - e^{-k})，保證 E(0)=1, E(1)=0，嚴格遞減
  function discreteAvgE(k) {
    const ek = Math.exp(-k);
    const denom = 1 - ek;
    let sum = 0;
    for (let i = 0; i < T; i++) {
      const u = i / T;
      sum += (Math.exp(-k * u) - ek) / denom;
    }
    return sum / T;
  }

  // 穩健二分解 k：自動擴張區間以涵蓋根（避免 A 很接近 0 或 1 時取不到號差）
  function solveK(A) {
    if (!Number.isFinite(A)) return 0;
    if (A <= 1e-9) return 60; // 幾乎全尾段
    if (A >= 1 - 1e-9) return -60; // 幾乎全前段

    let lo = A > 0.5 ? -60 : 1e-6; // A>0.5 → k<0；A<0.5 → k>0
    let hi = A > 0.5 ? -1e-6 : 60;

    let flo = discreteAvgE(lo) - A;
    let fhi = discreteAvgE(hi) - A;

    // 擴張到有號差或到極限
    let expand = 0;
    while (flo * fhi > 0 && expand < 6) {
      if (A > 0.5) lo *= 2;
      else hi *= 2;
      flo = discreteAvgE(lo) - A;
      fhi = discreteAvgE(hi) - A;
      expand++;
    }

    // 二分
    for (let it = 0; it < 120; it++) {
      const mid = (lo + hi) / 2;
      const fmid = discreteAvgE(mid) - A;
      if (flo * fmid <= 0) {
        hi = mid;
        fhi = fmid;
      } else {
        lo = mid;
        flo = fmid;
      }
      if (Math.abs(hi - lo) < 1e-10) break;
    }
    return (lo + hi) / 2;
  }

  // 特例：rS==rF → 常數 ROR
  if (Math.abs(span) < 1e-9) {
    const rConst = Math.max(0, rS);
    const ptsC = [];
    let btExact = tpTemp;
    for (let i = 0; i <= T; i++) {
      if (i < T) btExact += rConst / 60;
      const bt = Number(btExact.toFixed(2));
      ptsC.push({ t: tpTime + i, bt, btExact, ror: Number(rConst.toFixed(2)) });
    }
    // 尾點極小誤差補償（不動 ROR）
    const err = dropTemp - ptsC[ptsC.length - 1].btExact;
    if (Math.abs(err) > 0.2) {
      const tail = Math.min(60, T);
      const t0 = fcTime - tail;
      let wsum = 0;
      for (let i = 0; i < ptsC.length; i++)
        if (ptsC[i].t >= t0) wsum += (ptsC[i].t - t0) / tail;
      const perW = wsum ? err / wsum : 0;
      for (let i = 0; i < ptsC.length; i++)
        if (ptsC[i].t >= t0) {
          const w = (ptsC[i].t - t0) / tail;
          ptsC[i].btExact = ptsC[i].btExact + perW * w;
          ptsC[i].bt = Number(ptsC[i].btExact.toFixed(2)); // 同步 btExact → bt
        }
    }
    return ptsC;
  }

  const k = solveK(A);
  const ek = Math.exp(-k);
  const denom = 1 - ek;

  // 生成單調 ROR；理論上嚴格遞減，但仍以「不回升壓平」保險
  const r = new Array(T + 1);
  for (let i = 0; i <= T; i++) {
    const u = i / T;
    const E = (Math.exp(-k * u) - ek) / denom; // 1 → 0
    r[i] = Math.max(0, rF + span * E);
  }
  for (let i = 1; i <= T; i++) if (r[i] > r[i - 1]) r[i] = r[i - 1];
  r[T] = Math.min(r[T], Math.max(0, rF));
  if (T >= 1 && r[T] > r[T - 1]) r[T] = r[T - 1];

  // 由 ROR 積分出 BT（離散左矩形，與解 k 的方法匹配）
  const pts = [];
  let btExact = tpTemp;
  for (let i = 0; i <= T; i++) {
    if (i < T) btExact += r[i] / 60;
    const bt = Number(btExact.toFixed(2));
    pts.push({ t: tpTime + i, bt, btExact, ror: Number(r[i].toFixed(2)) });
  }

  // 尾點極小誤差補償（僅 BT，**同步 btExact**，不動 ROR）
  const last = pts.length - 1;
  const err = dropTemp - pts[last].btExact;
  if (Math.abs(err) > 0.2) {
    const tail = Math.min(60, T);
    const t0 = fcTime - tail;
    let wsum = 0;
    for (let i = 0; i <= last; i++)
      if (pts[i].t >= t0) wsum += (pts[i].t - t0) / tail;
    const perW = wsum ? err / wsum : 0;
    for (let i = 0; i <= last; i++)
      if (pts[i].t >= t0) {
        const w = (pts[i].t - t0) / tail;
        pts[i].btExact = pts[i].btExact + perW * w; // 同步精確值
        pts[i].bt = Number(pts[i].btExact.toFixed(2)); // 再同步顯示值
      }
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

  /* ===== 草稿參數（綁 input） ===== */
  const [tpTime, setTpTime] = useState(60);
  const [tpTemp, setTpTemp] = useState(100);
  const [fcTime, setFcTime] = useState(450); // 總烘焙時間（秒）
  const [fcTemp, setFcTemp] = useState(188); // 一爆溫度（°C）
  const [dropTemp, setDropTemp] = useState(204); // 下豆溫度（°C）
  const [rorStart, setRorStart] = useState(20); // 起始 ROR
  const [rorFC, setRorFC] = useState(10); // 末端 ROR
  const [yellowTemp, setYellowTemp] = useState(145);

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

  // 建議範圍計算：依 TP、Drop、fcTime、末端 ROR 推算初始 ROR 建議區間
  const rorStartRange = useMemo(() => {
    const T = Math.max(1, fcTime - tpTime);
    const delta = dropTemp - tpTemp;
    const Ravg = (60 * delta) / T;
    const aL = 0.35,
      aU = 0.65;
    if (Ravg <= rorFC) return null;
    const lo = rorFC + (Ravg - rorFC) / aU;
    const hi = rorFC + (Ravg - rorFC) / aL;
    return [lo.toFixed(1), hi.toFixed(1)];
  }, [tpTime, tpTemp, fcTime, dropTemp, rorFC]);

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

  // 允許任意秒數紅點；不對齊 intervalSec、不覆蓋舊點
const addActual = () => {
  const s = Number(actualTimeSec);
  const T = Number(actualTemp);
  if (!Number.isFinite(s) || !Number.isFinite(T)) return;

  const clamped = clamp(s, applied.tpTime, applied.fcTime);
  const t = Math.round(clamped * 10) / 10; // 可保留 0.1s 精度

  setActuals(prev => [...prev, { t, temp: T }].sort((a, b) => a.t - b.t));

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
            label={
              <>
                初始 ROR（°C/分）
                {rorStartRange && (
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--muted)',
                      marginLeft: 6,
                    }}
                  >
                    建議範圍：{rorStartRange[0]}–{rorStartRange[1]}
                  </span>
                )}
              </>
            }
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
              height: 20,
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
              gap: 40,
              marginTop: 4,
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
              style={{ display: 'flex', gap:0, flexWrap: 'wrap' }}
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
