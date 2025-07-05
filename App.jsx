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
      {/* 樣式放最上層，避免跨檔案，直接 copy paste 用 */}
      <style>{`
      body, .app-root, input, button, label, table, th, td {
        font-family: 'Inter', 'Noto Sans TC', Arial, '微軟正黑體', 'PingFang TC', 'Heiti TC', 'sans-serif' !important;
        font-weight: 400;
        letter-spacing: 0.02em;
      }
      
        body, .app-root {
          font-family: 'Inter', 'Noto Sans TC', Arial, "微軟正黑體", sans-serif;
          background: #f9fafb;
        }
        .main-container {
          max-width: 660px;
          margin: 36px auto 24px auto;
          background: #fff;
          border-radius: 20px;
          box-shadow: 0 4px 16px 0 rgba(50,55,77,0.07);
          padding: 36px 28px 32px 28px;
        }
        .title {
          font-weight: 700;
          font-size: 2rem;
          letter-spacing: 0.04em;
          color: #282828;
          margin-bottom: 18px;
          font-family: 'Noto Sans TC', 'Inter', Arial, sans-serif;
        }
        .form-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 20px 28px;
          margin-bottom: 24px;
        }
        .form-item label {
          font-weight: 600;
          font-size: 1rem;
          margin-bottom: 4px;
          display: block;
        }
        .form-item input[type='number'] {
          width: 100%;
          padding: 6px 8px;
          border-radius: 8px;
          border: 1px solid #d8dde7;
          font-size: 1.06rem;
          outline: none;
          transition: border 0.2s;
        }
        .form-item input[type='number']:focus {
          border: 1.5px solid #b95b16;
        }
        .switch-row {
          grid-column: span 2;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .form-actions {
          grid-column: span 2;
          margin-top: 5px;
        }
        .gen-btn {
          width: 100%;
          padding: 10px 0;
          background: #b95b16;
          color: #fff;
          border: none;
          border-radius: 10px;
          font-size: 1.12rem;
          font-weight: 700;
          cursor: pointer;
          margin-top: 6px;
          letter-spacing: 0.04em;
          transition: background 0.15s;
        }
        .gen-btn:hover {
          background: #913f0d;
        }
        .actual-row {
          display: grid;
          grid-template-columns: 1.3fr 1.3fr 1fr;
          gap: 12px;
          margin-bottom: 12px;
        }
        .actual-row input[type='number'] {
          width: 100%;
        }
        .actual-row button {
          background: #0b4d91;
          color: #fff;
          border: none;
          border-radius: 8px;
          padding: 7px 0;
          font-weight: 600;
          font-size: 1rem;
          cursor: pointer;
        }
        .card {
          background: #f8f6f3;
          border-radius: 18px;
          padding: 22px 18px 18px 18px;
          box-shadow: 0 2px 8px 0 rgba(80,60,40,0.08);
          margin-top: 16px;
        }
        .chart-container {
          height: 320px;
        }
        .meta-info {
          font-size: 15px;
          color: #444;
          margin: 8px 0 0 2px;
        }
        .data-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 12px;
          font-size: 15px;
          background: #fff;
          border-radius: 10px;
          overflow: hidden;
        }
        .data-table th, .data-table td {
          border: 1px solid #ececec;
          padding: 7px 8px;
          text-align: center;
        }
        .data-table th {
          background: #f2f5f7;
          font-weight: 700;
        }
        @media (max-width: 680px) {
          .main-container {
            padding: 16px 2vw;
          }
          .form-grid {
            grid-template-columns: 1fr;
          }
          .switch-row, .form-actions {
            grid-column: span 1;
          }
        }
      `}</style>

      <div className="main-container">
        <div className="title">烘豆 ROR 預測工具</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleGenerate();
          }}
          autoComplete="off"
        >
          <div className="form-grid">
            <div className="form-item">
              <label>回溫點時間（秒）</label>
              <input
                type="number"
                value={startTime}
                onChange={(e) =>
                  setStartTime(
                    e.target.value === '' ? '' : Number(e.target.value)
                  )
                }
                min={0}
              />
            </div>
            <div className="form-item">
              <label>回溫點溫度（°C）</label>
              <input
                type="number"
                value={startTemp}
                onChange={(e) =>
                  setStartTemp(
                    e.target.value === '' ? '' : Number(e.target.value)
                  )
                }
                min={0}
              />
            </div>
            <div className="form-item">
              <label>一爆目標時間（秒）</label>
              <input
                type="number"
                value={targetTime}
                onChange={(e) =>
                  setTargetTime(
                    e.target.value === '' ? '' : Number(e.target.value)
                  )
                }
                min={0}
              />
            </div>
            <div className="form-item">
              <label>一爆目標溫度（°C）</label>
              <input
                type="number"
                value={targetTemp}
                onChange={(e) =>
                  setTargetTemp(
                    e.target.value === '' ? '' : Number(e.target.value)
                  )
                }
                min={0}
              />
            </div>
            <div className="form-item">
              <label>初始 ROR（°C/分）</label>
              <input
                type="number"
                value={startROR}
                onChange={(e) =>
                  setStartROR(
                    e.target.value === '' ? '' : Number(e.target.value)
                  )
                }
                min={0}
              />
            </div>
            <div className="form-item">
              <label>一爆目標 ROR（°C/分）</label>
              <input
                type="number"
                value={targetROR}
                onChange={(e) =>
                  setTargetROR(
                    e.target.value === '' ? '' : Number(e.target.value)
                  )
                }
                min={0}
              />
            </div>
            <div className="switch-row">
              <input
                type="checkbox"
                checked={showPerMinute}
                onChange={() => setShowPerMinute(!showPerMinute)}
              />
              <span>顯示單位：{showPerMinute ? '°C/分' : '°C/30秒'}</span>
            </div>
            <div className="form-actions">
              <button type="submit" className="gen-btn">
                產生預測曲線表格
              </button>
            </div>
          </div>
        </form>

        <div className="card">
          <div className="actual-row">
            <div>
              <label>實際時間（秒）</label>
              <input
                type="number"
                value={actualTime}
                onChange={(e) => setActualTime(e.target.value)}
                min={0}
              />
            </div>
            <div>
              <label>實際溫度（°C）</label>
              <input
                type="number"
                value={actualTemp}
                onChange={(e) => setActualTemp(e.target.value)}
                min={0}
              />
            </div>
            <button onClick={handleAddActual}>加入實際紀錄</button>
          </div>

          {profile.length > 0 && (
            <>
              <div
                style={{
                  marginBottom: 10,
                  fontWeight: 600,
                  fontSize: '1.09rem',
                  color: '#b95b16',
                }}
              >
                預測溫度曲線視覺對照
              </div>
              <div className="chart-container">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <XAxis dataKey="time" minTickGap={15} />
                    <YAxis
                      yAxisId="left"
                      label={{
                        value: '溫度 (°C)',
                        angle: -90,
                        position: 'insideLeft',
                      }}
                      domain={[
                        (dataMin) => Math.floor(dataMin - 3),
                        (dataMax) => Math.ceil(dataMax + 3),
                      ]}
                      allowDecimals={true}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      label={{
                        value: 'ROR (°C/分)',
                        angle: 90,
                        position: 'insideRight',
                      }}
                      domain={[
                        (dataMin) => Math.floor(dataMin - 5),
                        (dataMax) => Math.ceil(dataMax + 5),
                      ]}
                      allowDecimals={true}
                    />
                    <Tooltip />
                    <Legend />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="預測溫度"
                      stroke="#b95b16"
                      strokeWidth={3}
                      dot={false}
                    />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="實際溫度"
                      stroke="#0b4d91"
                      strokeWidth={2}
                      dot={{ r: 4 }}
                      isAnimationActive={false}
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="預測ROR"
                      stroke="#8884d8"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="meta-info">
                最終溫度誤差：{finalTempError?.toFixed(2)}°C，最終 ROR 誤差：
                {finalRORError?.toFixed(2)}°C/分
              </div>
            </>
          )}

          {profile.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>時間</th>
                    <th>預測溫度（°C）</th>
                    <th>
                      預測升溫速率（{showPerMinute ? '°C/分' : '°C/30秒'})
                    </th>
                    <th>實際溫度（若有）</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.map((row, i) => {
                    const actual = actuals.find((a) => a.time === row.time);
                    return (
                      <tr key={i}>
                        <td>{row.time}</td>
                        <td>{row.temperature}</td>
                        <td>
                          {(showPerMinute
                            ? parseFloat(row.ror)
                            : parseFloat(row.ror) / 2
                          ).toFixed(1)}
                        </td>
                        <td>{actual?.temperature || ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
