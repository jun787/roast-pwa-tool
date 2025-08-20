import React, { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Scatter,
} from "recharts";

/**
 * Roast ROR 對照工具（六參數）
 * - 表格：美化（抬頭著色、數值配色、斑馬紋、黏性表頭、隨系統深淺色）
 * - 圖表：只顯示 TP 之後；無格線；實際點用紅色圓點疊加（不連線、不覆蓋原曲線）
 * - 參數：TP時間/溫度、FC目標時間/溫度、初始ROR、FC目標ROR
 * - 對照：每 30/60 秒節點；ROR 單位 °C/分 或 °C/30秒
 */

/* ---------- 小工具 ---------- */
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

/* ---------- 以 6 參數生成 TP→FC 曲線（1s解析） ---------- */
function generateCurve6({ tpTime, tpTemp, fcTime, fcTemp, rorStart, rorFC }) {
  const dt = 1;
  const n = Math.max(1, Math.round(fcTime / dt));
  const pts = [];
  let bt = tpTemp;

  for (let i = 0; i <= n; i++) {
    const t = i * dt;
    let ror;

    if (t < tpTime) {
      // TP 之前做視覺銜接（稍後會在圖上過濾掉）
      const frac = t / Math.max(1, tpTime);
      ror = rorStart * 0.6 * frac;
      bt = tpTemp - (rorStart * 0.2) * ((tpTime - t) / 60);
    } else {
      const f = (t - tpTime) / Math.max(1, fcTime - tpTime);
      ror = rorStart + (rorFC - rorStart) * clamp(f, 0, 1);
      bt += (ror / 60) * dt;
    }

    pts.push({
      t,
      timeLabel: secToMMSS(t), // 給 X 軸用
      bt: Number(bt.toFixed(2)),
      ror: Number((ror || 0).toFixed(2)),
    });
  }

  // 以一爆目標溫度作終點校正
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

export default function RoastRORTool() {
  /* ---------- 參數 ---------- */
  const [tpTime, setTpTime] = useState(60);
  const [tpTemp, setTpTemp] = useState(100);
  const [fcTime, setFcTime] = useState(450);
  const [fcTemp, setFcTemp] = useState(188);
  const [rorStart, setRorStart] = useState(20);
  const [rorFC, setRorFC] = useState(10);

  /* ---------- 設定 ---------- */
  const [intervalSec, setIntervalSec] = useState(30); // 30/60
  const [unitPerMin, setUnitPerMin] = useState(true); // °C/分 / °C/30秒

  /* ---------- 實際點（只畫在圖上） ---------- */
  const [actuals, setActuals] = useState([]); // { t, timeLabel, temp }
  const [actualTimeSec, setActualTimeSec] = useState("");
  const [actualTemp, setActualTemp] = useState("");

  /* ---------- 生成曲線 ---------- */
  const data = useMemo(
    () => generateCurve6({ tpTime, tpTemp, fcTime, fcTemp, rorStart, rorFC }),
    [tpTime, tpTemp, fcTime, fcTemp, rorStart, rorFC]
  );
  // 只顯示 TP 之後
  const chartData = useMemo(
    () => data.filter((d) => d.t >= tpTime),
    [data, tpTime]
  );

  // 取樣節點（TP→FC）
  const checkpoints = useMemo(
    () =>
      chartData.filter((d) => d.t % intervalSec === 0 && d.t <= fcTime),
    [chartData, fcTime, intervalSec]
  );

  // 表格資料（僅目標值）
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

  // 圖上的實際點（使用 Scatter 疊加，避免覆蓋曲線）
  const actualDots = useMemo(
    () =>
      [...actuals]
        .sort((a, b) => a.t - b.t)
        .map((x) => ({ t: x.t, timeLabel: secToMMSS(x.t), actual: x.temp })),
    [actuals]
  );

  // 新增實際點（自動對齊最近節點）
  const addActual = () => {
    const s = Number(actualTimeSec);
    const T = Number(actualTemp);
    if (!Number.isFinite(s) || !Number.isFinite(T)) return;
    const clamped = clamp(s, tpTime, fcTime);
    const aligned = clamped - (clamped % intervalSec);
    const t = aligned;
    setActuals((prev) => {
      const others = prev.filter((x) => x.t !== t);
      return [...others, { t, timeLabel: secToMMSS(t), temp: T }];
    });
    setActualTimeSec("");
    setActualTemp("");
  };

  const btGain =
    (data.find((d) => d.t === fcTime)?.bt ?? fcTemp) - tpTemp;
  const rorDrift = rorFC - rorStart;

  /* ---------- UI ---------- */
  return (
    <div className="min-h-screen w-full bg-white dark:bg-[#0f0f12] text-slate-900 dark:text-[#f7f7f7] p-6">
      <div className="max-w-6xl mx-auto">
        {/* 標題 */}
        <div className="mb-6">
          <h1 className="text-3xl md:text-5xl font-extrabold tracking-wide">
            <span className="dark:text-white">烘</span>
            <span className="text-orange-600">ROR</span>
            <span className="dark:text-white"> 對照工具</span>
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            輸入 6 參數 → 生成 TP→FC 曲線與對照表；支援 iPhone，隨系統深淺色切換。
          </p>
        </div>

        {/* 參數面板 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <Field label="回溫點時間（秒）" value={tpTime} onChange={setTpTime} />
          <Field label="回溫點溫度（°C）" value={tpTemp} onChange={setTpTemp} />
          <Field label="一爆目標時間（秒）" value={fcTime} onChange={setFcTime} />
          <Field label="一爆目標溫度（°C）" value={fcTemp} onChange={setFcTemp} />
          <Field label="初始 ROR（°C/分）" value={rorStart} onChange={setRorStart} />
          <Field label="一爆目標 ROR（°C/分）" value={rorFC} onChange={setRorFC} />
        </div>

        {/* 控制 */}
        <div className="flex flex-wrap items-center gap-4 mb-4">
          <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={unitPerMin}
              onChange={() => setUnitPerMin((v) => !v)}
            />
            顯示單位：{unitPerMin ? "°C/分" : "°C/30秒"}
          </label>
          <div className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            對照間隔：
            <select
              className="bg-white dark:bg-transparent border border-gray-300 dark:border-[#2a2a2f] px-2 py-1 rounded"
              value={intervalSec}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
            >
              <option value={30}>每 30 秒</option>
              <option value={60}>每 60 秒</option>
            </select>
          </div>
        </div>

        {/* 實際點輸入 */}
        <div className="bg-white dark:bg-[#16161a] rounded-xl p-4 mb-4 border border-gray-200 dark:border-[#2a2a2f]">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
            <button
              className="bg-orange-400 hover:bg-orange-500 text-black font-semibold rounded-xl px-4 py-2"
              onClick={addActual}
            >
              加入實際點（圖上紅點）
            </button>
          </div>
        </div>

        {/* 圖表（無格線；橘=BT、藍=ROR；紅點=實際） */}
        <div className="bg-white dark:bg-[#16161a] rounded-xl p-4 mb-4 border border-gray-200 dark:border-[#2a2a2f]">
          <div className="text-sm text-gray-700 dark:text-gray-300 mb-2">
            預測溫度曲線視覺對照
          </div>
          <ResponsiveContainer width="100%" height={360}>
            <LineChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
              <XAxis
                dataKey="timeLabel"
                tick={{ fontSize: 12, fill: "#6b7280" }}
                interval={Math.max(0, Math.floor(chartData.length / 10))}
                axisLine={{ stroke: "#9ca3af" }}
                tickLine={{ stroke: "#9ca3af" }}
              />
              <YAxis
                yAxisId="left"
                domain={[Math.min(tpTemp - 10, 80), Math.max(fcTemp + 12, 210)]}
                tick={{ fontSize: 12, fill: "#6b7280" }}
                axisLine={{ stroke: "#9ca3af" }}
                tickLine={{ stroke: "#9ca3af" }}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={[0, Math.max(24, rorStart + 4)]}
                tick={{ fontSize: 12, fill: "#6b7280" }}
                axisLine={{ stroke: "#9ca3af" }}
                tickLine={{ stroke: "#9ca3af" }}
              />
              <Tooltip contentStyle={{ background: "#1e1e23", border: "1px solid #2a2a2f", color: "#fff" }} />
              <Legend wrapperStyle={{ color: "#6b7280" }} />
              {/* 橘=預測溫度、藍=預測ROR */}
              <Line yAxisId="left" type="monotone" dataKey="bt"  name="預測溫度" stroke="#f59e0b" strokeWidth={2} dot={false} />
              <Line yAxisId="right" type="monotone" dataKey="ror" name="預測ROR" stroke="#60a5fa" strokeWidth={2} dot={false} />
              {/* 🔴 實際紅點（不連線、不覆蓋） */}
              {actualDots.length > 0 && (
                <Scatter yAxisId="left" data={actualDots} name="實際溫度" fill="#ef4444" shape="circle" />
              )}
            </LineChart>
          </ResponsiveContainer>
          <div className="text-xs text-gray-600 dark:text-gray-400 mt-2">
            最終增溫：約 {btGain.toFixed(2)}°C；ROR 變化：{rorDrift.toFixed(2)} °C/分。
          </div>
        </div>

        {/* 底部表格（美化版） */}
        <div className="bg-white dark:bg-[#16161a] rounded-xl p-4 border border-gray-200 dark:border-[#2a2a2f]">
          <div className="text-base font-semibold mb-2 text-gray-800 dark:text-gray-200">
            {intervalSec === 30 ? "每 30 秒" : "每 60 秒"} 目標表
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="sticky top-0 z-10 text-left  px-3 py-2 bg-amber-100 text-amber-900 dark:bg-[#1f1f25] dark:text-gray-200">時間</th>
                  <th className="sticky top-0 z-10 text-right px-3 py-2 bg-amber-100 text-amber-900 dark:bg-[#1f1f25] dark:text-gray-200">目標溫度（°C）</th>
                  <th className="sticky top-0 z-10 text-right px-3 py-2 bg-amber-100 text-amber-900 dark:bg-[#1f1f25] dark:text-gray-200">目標升溫速率（{unitPerMin ? "°C/分" : "°C/30秒"}）</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r, idx) => (
                  <tr key={r.t} className={`${idx % 2 ? "bg-gray-50 dark:bg-transparent" : ""}`}>
                    <td className="px-3 py-2 border-b border-gray-200 dark:border-[#2a2a2f] font-medium text-slate-800 dark:text-slate-200">{r.timeLabelZh}</td>
                    <td className="px-3 py-2 text-right border-b border-gray-200 dark:border-[#2a2a2f] text-orange-500">{r.targetBT.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right border-b border-gray-200 dark:border-[#2a2a2f] text-blue-400">{r.targetROR.toFixed(1)}</td>
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

/* ---------- 小型表單元件 ---------- */
function Field({ label, value, onChange }) {
  return (
    <label className="block">
      <div className="text-xs text-gray-600 dark:text-gray-400 mb-1">{label}</div>
      <input
        type="number"
        className="w-full bg-white dark:bg-[#16161a] border border-gray-300 dark:border-[#2a2a2f] rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-orange-400"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function SmallField({ label, value, onChange, placeholder }) {
  return (
    <label className="block">
      <div className="text-xs text-gray-600 dark:text-gray-400 mb-1">{label}</div>
      <input
        type="number"
        placeholder={placeholder}
        className="w-full bg-white dark:bg-[#0f0f12] border border-gray-300 dark:border-[#2a2a2f] rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-orange-400"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
