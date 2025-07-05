import React, { useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

function formatTime(seconds) {
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}分${sec.toString().padStart(2, '0')}秒`;
}

function calculateSmoothProfile({
  startTime,
  startTemp,
  targetTime,
  targetTemp,
  startROR,
  targetROR,
  tempTolerance = 2.0,
  maxIterations = 30,
}) {
  const duration = targetTime - startTime;
  const steps = Math.floor(duration / 30);
  const rorStep = (targetROR - startROR) / steps;

  let temps = [startTemp];
  let rors = [startROR];
  let profile = [];

  for (let i = 1; i <= steps; i++) {
    let nextROR = startROR + rorStep * i;
    rors.push(nextROR);
  }

  for (let i = 1; i <= steps; i++) {
    let temp = temps[i - 1] + rors[i - 1] * 0.5;
    temps.push(temp);
  }

  let tempErr = temps[temps.length - 1] - targetTemp;
  let adjustStep = 0;
  while (Math.abs(tempErr) > tempTolerance && adjustStep < maxIterations) {
    let offset = -tempErr / (steps + 1) / 0.5;
    rors = rors.map((v) => v + offset);
    temps = [startTemp];
    for (let i = 1; i <= steps; i++) {
      let temp = temps[i - 1] + rors[i - 1] * 0.5;
      temps.push(temp);
    }
    tempErr = temps[temps.length - 1] - targetTemp;
    adjustStep++;
  }

  for (let i = 0; i <= steps; i++) {
    const formattedTime = formatTime(startTime + i * 30);
    profile.push({
      time: formattedTime,
      temperature: Number(temps[i]).toFixed(1),
      ror: Number(rors[i]).toFixed(1),
      raw_temp: temps[i],
      raw_ror: rors[i],
    });
  }

  return {
    profile,
    finalTempError: tempErr,
    finalRORError: rors[rors.length - 1] - targetROR,
    iterations: adjustStep,
  };
}

export default function App() {
  // 狀態欄
  const [startTime, setStartTime] = useState(60);
  const [startTemp, setStartTemp] = useState(100);
  const [targetTime, setTargetTime] = useState(450);
  const [targetTemp, setTargetTemp] = useState(188);
  const [startROR, setStartROR] = useState(20);
  const [targetROR, setTargetROR] = useState(10);
  const [showPerMinute, setShowPerMinute] = useState(true);
  const [profile, setProfile] = useState([]);
  const [finalTempError, setFinalTempError] = useState(0);
  const [finalRORError, setFinalRORError] = useState(0);
  const [actuals, setActuals] = useState([]);
  const [actualTime, setActualTime] = useState('');
  const [actualTemp, setActualTemp] = useState('');

  const handleGenerate = () => {
    const { profile, finalTempError, finalRORError } = calculateSmoothProfile({
      startTime: Number(startTime),
      startTemp: Number(startTemp),
      targetTime: Number(targetTime),
      targetTemp: Number(targetTemp),
      startROR: Number(startROR),
      targetROR: Number(targetROR),
      tempTolerance: 2,
      rorTolerance: 0.5,
    });
    setProfile(profile);
    setFinalTempError(finalTempError);
    setFinalRORError(finalRORError);
  };

  const handleAddActual = () => {
    if (!actualTime || !actualTemp) return;
    const formattedTime = formatTime(Number(actualTime));
    setActuals([
      ...actuals,
      { time: formattedTime, temperature: Number(actualTemp) },
    ]);
    setActualTime('');
    setActualTemp('');
  };

  const chartData = profile.map((row) => {
    const actual = actuals.find((a) => a.time === row.time);
    return {
      time: row.time,
      預測溫度: Number(row.temperature),
      預測ROR: Number(row.ror),
      實際溫度: actual ? Number(actual.temperature) : null,
    };
  });
  return (
    <div className="app-root">
      <div className="main-header">
        <h1>烘豆 <span className="accent">ROR</span> 預測工具</h1>
      </div>
      <form
        onSubmit={e => {
          e.preventDefault();
          handleGenerate();
        }}
        autoComplete="off"
      >
        <div className="form-grid-2col">
          <div className="form-row">
            <label>回溫點時間（秒）</label>
            <input type="number" value={startTime} onChange={e => setStartTime(e.target.value === '' ? '' : Number(e.target.value))} min={0} />
          </div>
          <div className="form-row">
            <label>回溫點溫度（°C）</label>
            <input type="number" value={startTemp} onChange={e => setStartTemp(e.target.value === '' ? '' : Number(e.target.value))} min={0} />
          </div>
          <div className="form-row">
            <label>一爆目標時間（秒）</label>
            <input type="number" value={targetTime} onChange={e => setTargetTime(e.target.value === '' ? '' : Number(e.target.value))} min={0} />
          </div>
          <div className="form-row">
            <label>一爆目標溫度（°C）</label>
            <input type="number" value={targetTemp} onChange={e => setTargetTemp(e.target.value === '' ? '' : Number(e.target.value))} min={0} />
          </div>
          <div className="form-row">
            <label>初始 ROR（°C/分）</label>
            <input type="number" value={startROR} onChange={e => setStartROR(e.target.value === '' ? '' : Number(e.target.value))} min={0} />
          </div>
          <div className="form-row">
            <label>一爆目標 ROR（°C/分）</label>
            <input type="number" value={targetROR} onChange={e => setTargetROR(e.target.value === '' ? '' : Number(e.target.value))} min={0} />
          </div>
        </div>
  
        <div className="unit-row">
          <input type="checkbox" checked={showPerMinute} id="unit-switch" onChange={() => setShowPerMinute(!showPerMinute)} />
          <label htmlFor="unit-switch" style={{ margin: 0 }}>顯示單位：<b>{showPerMinute ? "°C/分" : "°C/30秒"}</b></label>
        </div>
  
        <button className="gen-btn" type="submit">產生預測曲線表格</button>
      </form>
  
      <div className="card">
        <div className="row-flex" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>實際時間（秒）</label>
            <input type="number" value={actualTime} onChange={e => setActualTime(e.target.value)} min={0} />
          </div>
          <div style={{ flex: 1 }}>
            <label>實際溫度（°C）</label>
            <input type="number" value={actualTemp} onChange={e => setActualTemp(e.target.value)} min={0} />
          </div>
          <button className="gen-btn" style={{ flex: 1, minWidth: 120 }} onClick={handleAddActual} type="button">
            加入實際紀錄
          </button>
        </div>
  
        {profile.length > 0 && (
          <>
            <div className="chart-container" style={{ height: 320, margin: "22px 0 0 0" }}>
              <div style={{ marginBottom: 10, fontWeight: 600, fontSize: "1.13rem", color: "#b95b16" }}>
                預測溫度曲線視覺對照
              </div>
              <ResponsiveContainer width="100%" height="80%">
                <LineChart data={chartData}>
                  <XAxis dataKey="time" minTickGap={15} />
                  <YAxis yAxisId="left" label={{ value: "溫度 (°C)", angle: -90, position: "insideLeft" }} domain={[dataMin => Math.floor(dataMin - 3), dataMax => Math.ceil(dataMax + 3)]} allowDecimals={true} />
                  <YAxis yAxisId="right" orientation="right" label={{ value: "ROR (°C/分)", angle: 90, position: "insideRight" }} domain={[dataMin => Math.floor(dataMin - 5), dataMax => Math.ceil(dataMax + 5)]} allowDecimals={true} />
                  <Tooltip />
                  <Legend />
                  <Line yAxisId="left" type="monotone" dataKey="預測溫度" stroke="#b95b16" strokeWidth={3} dot={false} />
                  <Line yAxisId="left" type="monotone" dataKey="實際溫度" stroke="#0b4d91" strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
                  <Line yAxisId="right" type="monotone" dataKey="預測ROR" stroke="#8884d8" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
              <div className="meta-info" style={{ margin: "10px 0 0 0", fontSize: 14 }}>
                最終溫度誤差：{finalTempError?.toFixed(2)}°C，最終 ROR 誤差：{finalRORError?.toFixed(2)}°C/分
              </div>
            </div>
  
            <div style={{ marginTop: 18 }}>
              <table className="data-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>時間</th>
                    <th>預測溫度（°C）</th>
                    <th>預測升溫速率（{showPerMinute ? "°C/分" : "°C/30秒"})</th>
                    <th>實際溫度（若有）</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.map((row, i) => {
                    const actual = actuals.find(a => a.time === row.time);
                    return (
                      <tr key={i}>
                        <td>{row.time}</td>
                        <td>{row.temperature}</td>
                        <td>{(showPerMinute ? parseFloat(row.ror) : parseFloat(row.ror) / 2).toFixed(1)}</td>
                        <td>{actual?.temperature || ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
  
}
