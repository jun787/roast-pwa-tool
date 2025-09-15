import React, { useMemo, useState, useEffect } from 'react';
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

/* ===== 你的預測曲線（維持原樣）：TP → 末端（1s step） =====
   注意：fcTime = 總烘焙時間；尾點 BT 對齊 dropTemp（下豆） */
function generateCurve6({
  tpTime,
  tpTemp,
  fcTime,
  fcTemp,
  rorStart,
  rorFC,
  dropTemp,
}) {
  const dt = 1;
  const n = Math.max(1, Math.round(fcTime / dt));
  const pts = [];
  let bt = tpTemp;

  for (let i = 0; i <= n; i++) {
    const t = i * dt;
    let ror;
    if (t < tpTime) {
      const frac = t / Math.max(1, tpTime);
      ror = rorStart * 0.6 * frac;
      bt = tpTemp - rorStart * 0.2 * ((tpTime - t) / 60);
    } else {
      const f = (t - tpTime) / Math.max(1, fcTime - tpTime);
      ror = rorStart + (rorFC - rorStart) * Math.max(0, Math.min(1, f));
      bt += (ror / 60) * dt;
    }
    pts.push({
      t,
      bt: Number(bt.toFixed(2)),
      ror: Number((ror || 0).toFixed(2)),
    });
  }

  if (pts.length && Number.isFinite(dropTemp)) {
    const last = pts[pts.length - 1];
    const delta = dropTemp - last.bt;
    if (Math.abs(delta) > 0.3) {
      for (let i = 0; i < pts.length; i++) {
        const w = i / Math.max(1, pts.length - 1);
        pts[i].bt = Number((pts[i].bt + delta * w).toFixed(2));
      }
    }
  }
  return pts;
}

export default function App() {
  useEffect(() => {
    document.title = '烘豆參數預測工具';
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
  const data = useMemo(() => generateCurve6(applied), [applied]);

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

  return (
    <div className="page">
      <div className="wrap">
        {/* Title */}
        <div className="titleBar">
          <h1>烘豆參數預測工具</h1>
        </div>

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
