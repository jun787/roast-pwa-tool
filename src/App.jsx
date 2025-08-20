import React, { useMemo, useState, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import "./App.css";

/* ===== Helpers ===== */
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const secToMMSS = (s) => {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
};
const secToZH = (s) => {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}分${ss.toString().padStart(2, "0")}秒`;
};

/* ===== Generate curve (TP → FC, 1s step) ===== */
function generateCurve6({ tpTime, tpTemp, fcTime, fcTemp, rorStart, rorFC }) {
  const dt = 1;
  const n = Math.max(1, Math.round(fcTime / dt));
  const pts = [];
  let bt = tpTemp;

  for (let i = 0; i <= n; i++) {
    const t = i * dt;
    let ror;

    if (t < tpTime) {
      // TP 前段僅銜接，圖上不顯示
      const frac = t / Math.max(1, tpTime);
      ror = rorStart * 0.6 * frac;
      bt = tpTemp - (rorStart * 0.2) * ((tpTime - t) / 60);
    } else {
      const f = (t - tpTime) / Math.max(1, fcTime - tpTime);
      ror = rorStart + (rorFC - rorStart) * Math.max(0, Math.min(1, f));
      bt += (ror / 60) * dt;
    }

    pts.push({
      t,                         // ← 用「秒」當數值型 X
      bt: Number(bt.toFixed(2)), // 預測豆溫
      ror: Number((ror || 0).toFixed(2)), // 預測 ROR（°C/分）
    });
  }

  // 校正：使 BT(fcTime)=fcTemp
  const last = pts[pts.length - 1];
  const delta = fcTemp - last.bt;
  if (Math.abs(delta) > 0.3) {
    for (let i = 0; i < pts.length; i++) {
      const w = i / (pts.length - 1);
      pts[i].bt = Number((pts[i].bt + delta * w).toFixed(2));
    }
  }
  return pts;
}

export default function App() {
  useEffect(() => { document.title = "烘豆參數預測工具"; }, []);

  /* ===== 草稿參數（綁 input） ===== */
  const [tpTime, setTpTime] = useState(60);
  const [tpTemp, setTpTemp] = useState(100);
  const [fcTime, setFcTime] = useState(450);
  const [fcTemp, setFcTemp] = useState(188);
  const [rorStart, setRorStart] = useState(20);
  const [rorFC, setRorFC] = useState(10);

  /* ===== 已套用參數（圖表/表格使用） ===== */
  const [applied, setApplied] = useState({
    tpTime: 60, tpTemp: 100, fcTime: 450, fcTemp: 188, rorStart: 20, rorFC: 10,
  });

  /* 設定：節點與單位（即時生效） */
  const [intervalSec, setIntervalSec] = useState(30);
  const [unitPerMin, setUnitPerMin] = useState(true);

  /* 實際紅點（只畫在圖上） */
  const [actuals, setActuals] = useState([]); // { t, temp }
  const [actualTimeSec, setActualTimeSec] = useState("");
  const [actualTemp, setActualTemp] = useState("");

  /* 產生/更新曲線（只有按按鈕才更新） */
  const data = useMemo(() => generateCurve6(applied), [applied]);

  // 只取 TP 之後
  const chartData = useMemo(
    () => data.filter((d) => d.t >= applied.tpTime),
    [data, applied.tpTime]
  );

  // checkpoints (TP→FC)
  const checkpoints = useMemo(
    () => chartData.filter((d) => d.t % intervalSec === 0 && d.t <= applied.fcTime),
    [chartData, applied.fcTime, intervalSec]
  );

  // X 軸刻度（數值秒）；用 formatter 顯示 mm:ss
  const xTicks = useMemo(() => {
    const arr = [];
    for (let s = applied.tpTime; s <= applied.fcTime; s += intervalSec) arr.push(s);
    return arr;
  }, [applied.tpTime, applied.fcTime, intervalSec]);

  // 表格資料（僅目標）
  const tableRows = useMemo(
    () =>
      checkpoints.map((d) => ({
        t: d.t,
        timeLabelZh: secToZH(d.t),
        targetBT: d.bt,
        targetROR: Number((unitPerMin ? d.ror : d.ror / 2).toFixed(1)),
      })),
    [checkpoints, unitPerMin]
  );

  // 紅點（用數值秒對齊）
  const actualDots = useMemo(
    () =>
      [...actuals]
        .sort((a, b) => a.t - b.t)
        .map((x) => ({ t: x.t, actual: x.temp })),
    [actuals]
  );

  // 新增紅點（對齊 interval；用已套用參數的 tp/fc 範圍）
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
    setActualTimeSec("");
    setActualTemp("");
  };

  // 套用參數按鈕
  const applyParams = () => {
    setApplied({ tpTime, tpTemp, fcTime, fcTemp, rorStart, rorFC });
  };

  // 安全的左側 Y 軸範圍
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

  return (
    <div className="page">
      <div className="wrap">
        {/* Title */}
        <div className="titleBar"><h1>烘豆參數預測工具</h1></div>

        {/* 參數輸入 */}
        <div className="grid">
          <Field label="回溫點時間（秒）" value={tpTime} onChange={setTpTime} />
          <Field label="回溫點溫度（°C）" value={tpTemp} onChange={setTpTemp} />
          <Field label="一爆目標時間（秒）" value={fcTime} onChange={setFcTime} />
          <Field label="一爆目標溫度（°C）" value={fcTemp} onChange={setFcTemp} />
          <Field label="初始 ROR（°C/分）" value={rorStart} onChange={setRorStart} />
          <div>
            <Field label="一爆目標 ROR（°C/分）" value={rorFC} onChange={setRorFC} />
            <button className="btnPrimary" style={{ marginTop: 8 }} onClick={applyParams}>
              產生預測曲線表格
            </button>
          </div>
        </div>

        {/* 設定 */}
        <div className="controls">
          <label className="labelRow">
            <input type="checkbox" checked={unitPerMin} onChange={() => setUnitPerMin(v=>!v)} />
            單位：{unitPerMin ? "°C/分" : "°C/30秒"}
          </label>
          <label className="labelRow">
            節點：
            <select className="select" value={intervalSec} onChange={(e)=>setIntervalSec(Number(e.target.value))}>
              <option value={30}>每 30 秒</option>
              <option value={60}>每 60 秒</option>
            </select>
          </label>
        </div>

        {/* 實際點輸入 */}
        <div className="card">
          <div className="gridThree">
            <SmallField label="實際時間（秒）" value={actualTimeSec} onChange={setActualTimeSec} placeholder="例如 180" />
            <SmallField label="實際溫度（°C）" value={actualTemp} onChange={setActualTemp} placeholder="例如 145.3" />
            <button className="btnPrimary" onClick={addActual}>加入實際點（紅色）</button>
          </div>
        </div>

        {/* 圖表（X 軸改為數值秒） */}
        <div className="card">
          <div className="cardTitle">預測溫度曲線視覺對照</div>
          <ResponsiveContainer width="100%" aspect={2.2}>
            <LineChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
              <XAxis
                type="number"
                dataKey="t"
                domain={[applied.tpTime, applied.fcTime]}
                ticks={xTicks}
                tickFormatter={secToMMSS}
                minTickGap={10}
                tick={{ fontSize: 12, fill: "var(--muted)" }}
                axisLine={{ stroke: "var(--muted)" }}
                tickLine={{ stroke: "var(--muted)" }}
              />
              <YAxis
                yAxisId="left"
                domain={[leftMin, leftMax]}
                tick={{ fontSize: 12, fill: "var(--muted)" }}
                axisLine={{ stroke: "var(--muted)" }}
                tickLine={{ stroke: "var(--muted)" }}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={[0, Math.max(24, applied.rorStart + 4)]}
                tick={{ fontSize: 12, fill: "var(--muted)" }}
                axisLine={{ stroke: "var(--muted)" }}
                tickLine={{ stroke: "var(--muted)" }}
              />
              <Tooltip
                labelFormatter={(value)=>secToMMSS(value)}
                contentStyle={{ background: "var(--tooltipBg)", border: "1px solid var(--tooltipBorder)", color: "var(--fg)" }}
                formatter={(v, name) => [v, name]}
              />
              <Legend wrapperStyle={{ color: "var(--muted)" }} />

              {/* 橘=BT、藍=ROR */}
              <Line yAxisId="left"  type="monotone" dataKey="bt"  name="預測溫度" stroke="#f59e0b" strokeWidth={2} dot={false} connectNulls />
              <Line yAxisId="right" type="monotone" dataKey="ror" name="預測ROR" stroke="#60a5fa" strokeWidth={2} dot={false} connectNulls />

              {/* 🔴 紅點：獨立資料、只畫 dot、不連線；x 用數值秒 t */}
              {actualDots.length > 0 && (
                <Line
                  yAxisId="left"
                  data={actualDots}
                  dataKey="actual"
                  name="實際溫度"
                  xAxisId={0}
                  xKey="t"
                  stroke="transparent"
                  dot={{ r: 5, stroke: "#ef4444", fill: "#ef4444" }}
                  isAnimationActive={false}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* 目標表 */}
        <div className="tableCard">
          <div className="tableHeader">{intervalSec === 30 ? "每 30 秒" : "每 60 秒"} 目標表</div>
          <div className="tableWrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="th">時間</th>
                  <th className="th">目標溫度（°C）</th>
                  <th className="th">目標升溫速率（{unitPerMin ? "°C/分" : "°C/30秒"}）</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r, idx) => (
                  <tr key={r.t} className={idx % 2 ? "tr zebra" : "tr"}>
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
      <input type="number" className="input" value={value} onChange={(e)=>onChange(Number(e.target.value))} />
    </label>
  );
}
function SmallField({ label, value, onChange, placeholder }) {
  return (
    <label className="field">
      <div className="label">{label}</div>
      <input type="number" className="input" placeholder={placeholder} value={value} onChange={(e)=>onChange(e.target.value)} />
    </label>
  );
}
