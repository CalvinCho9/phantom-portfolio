import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell, Legend, ReferenceLine } from "recharts";
import _ from "lodash";

// ─── PARSE ENGINE ────────────────────────────────────────────────
// Handles messy CSVs from Robinhood, Schwab, Fidelity, TD Ameritrade, E*Trade, Webull, generic
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  
  // Detect delimiter
  const firstLine = lines[0];
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  
  // Parse with quote handling
  function splitLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === delimiter && !inQuotes) { result.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    result.push(current.trim());
    return result;
  }
  
  const headers = splitLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, '_'));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitLine(lines[i]);
    if (vals.length < 2) continue;
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] || ''; });
    rows.push(row);
  }
  return rows;
}

function findField(row, candidates) {
  for (const c of candidates) {
    for (const key of Object.keys(row)) {
      if (key.includes(c)) return row[key];
    }
  }
  return null;
}

function parseDate(str) {
  if (!str) return null;
  const cleaned = str.replace(/['"]/g, '').trim();
  // Try various formats
  const formats = [
    /(\d{4})-(\d{1,2})-(\d{1,2})/, // 2024-01-15
    /(\d{1,2})\/(\d{1,2})\/(\d{4})/, // 01/15/2024
    /(\d{1,2})-(\d{1,2})-(\d{4})/, // 01-15-2024
    /(\d{1,2})\/(\d{1,2})\/(\d{2})/, // 01/15/24
  ];
  
  for (const fmt of formats) {
    const m = cleaned.match(fmt);
    if (m) {
      if (fmt === formats[0]) return new Date(+m[1], +m[2]-1, +m[3]);
      if (fmt === formats[3]) {
        const yr = +m[3] > 50 ? 1900 + +m[3] : 2000 + +m[3];
        return new Date(yr, +m[1]-1, +m[2]);
      }
      return new Date(+m[3], +m[1]-1, +m[2]);
    }
  }
  const d = new Date(cleaned);
  return isNaN(d) ? null : d;
}

function parseNum(str) {
  if (!str) return null;
  const cleaned = String(str).replace(/[$,\s'"()]/g, '').trim();
  if (cleaned.startsWith('(') || cleaned.startsWith('-')) {
    return -Math.abs(parseFloat(cleaned.replace(/[()-]/g, '')));
  }
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function normalizeTrades(rows, platform) {
  const trades = [];
  for (const row of rows) {
    const action = findField(row, ['action', 'type', 'transaction', 'side', 'activity', 'description', 'order']);
    if (!action) continue;
    
    const actionLower = action.toLowerCase();
    let type = null;
    if (/\bbuy\b|bought|purchase|market.?buy/i.test(actionLower)) type = 'BUY';
    else if (/\bsell\b|sold|sale|market.?sell/i.test(actionLower)) type = 'SELL';
    if (!type) continue;
    
    const symbol = findField(row, ['symbol', 'ticker', 'stock', 'instrument', 'security']);
    const date = parseDate(findField(row, ['date', 'time', 'executed', 'trade_date', 'settlement']));
    const qty = parseNum(findField(row, ['quantity', 'qty', 'shares', 'amount', 'units']));
    const price = parseNum(findField(row, ['price', 'cost', 'fill', 'execution', 'avg_price', 'average_price']));
    const total = parseNum(findField(row, ['total', 'amount', 'value', 'proceeds', 'net', 'cost_basis']));
    
    if (!symbol || !date) continue;
    
    const effectiveQty = qty ? Math.abs(qty) : (total && price ? Math.abs(total / price) : null);
    const effectivePrice = price || (total && effectiveQty ? Math.abs(total / effectiveQty) : null);
    
    if (!effectiveQty || !effectivePrice) continue;
    
    trades.push({
      id: trades.length + '-' + Date.now(),
      symbol: symbol.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5),
      type,
      date,
      quantity: effectiveQty,
      price: effectivePrice,
      total: effectiveQty * effectivePrice,
      platform: platform || 'Unknown',
      raw: row
    });
  }
  return trades.sort((a, b) => a.date - b.date);
}

// ─── WHAT-IF SIMULATOR ─────────────────────────────────────────
// Simple price simulation: uses last known price ± random walk
function simulateHoldStrategy(trades, symbol) {
  const symbolTrades = trades.filter(t => t.symbol === symbol);
  if (symbolTrades.length === 0) return null;
  
  const buys = symbolTrades.filter(t => t.type === 'BUY');
  const sells = symbolTrades.filter(t => t.type === 'SELL');
  
  const totalBought = buys.reduce((s, t) => s + t.quantity, 0);
  const avgBuyPrice = buys.reduce((s, t) => s + t.total, 0) / totalBought;
  const totalSold = sells.reduce((s, t) => s + t.quantity, 0);
  const sellProceeds = sells.reduce((s, t) => s + t.total, 0);
  
  const lastPrice = symbolTrades[symbolTrades.length - 1].price;
  const actualPL = sellProceeds - (buys.reduce((s, t) => s + t.total, 0));
  const holdValue = totalBought * lastPrice;
  const holdPL = holdValue - (buys.reduce((s, t) => s + t.total, 0));
  
  return {
    symbol,
    totalBought,
    avgBuyPrice,
    totalSold,
    sellProceeds,
    actualPL,
    holdValue,
    holdPL,
    lastKnownPrice: lastPrice,
    difference: holdPL - actualPL
  };
}

// ─── COLORS & THEME ─────────────────────────────────────────────
const COLORS = {
  bg: '#0a0e17',
  surface: '#111827',
  surfaceHover: '#1a2234',
  border: '#1e2d45',
  text: '#e2e8f0',
  textMuted: '#64748b',
  textDim: '#475569',
  accent: '#22d3ee',
  accentDim: 'rgba(34,211,238,0.15)',
  green: '#10b981',
  greenDim: 'rgba(16,185,129,0.15)',
  red: '#ef4444',
  redDim: 'rgba(239,68,68,0.15)',
  orange: '#f59e0b',
  purple: '#a78bfa',
  pink: '#ec4899',
  chart: ['#22d3ee', '#10b981', '#f59e0b', '#a78bfa', '#ec4899', '#ef4444', '#06b6d4', '#8b5cf6'],
};

const fmt = (n, decimals = 2) => {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
};
const fmtPct = n => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const fmtDate = d => d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—';

// ─── COMPONENTS ─────────────────────────────────────────────────
function Card({ children, style, onClick, className }) {
  return (
    <div onClick={onClick} className={className} style={{
      background: COLORS.surface,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 12,
      padding: 20,
      ...style,
    }}>{children}</div>
  );
}

function Stat({ label, value, sub, color }) {
  return (
    <div style={{ minWidth: 140 }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: COLORS.textMuted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || COLORS.text, fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Badge({ children, color }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 6,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.04em',
      background: color === 'green' ? COLORS.greenDim : color === 'red' ? COLORS.redDim : COLORS.accentDim,
      color: color === 'green' ? COLORS.green : color === 'red' ? COLORS.red : COLORS.accent,
    }}>{children}</span>
  );
}

function Tab({ active, children, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 18px',
      borderRadius: 8,
      border: 'none',
      background: active ? COLORS.accentDim : 'transparent',
      color: active ? COLORS.accent : COLORS.textMuted,
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
      transition: 'all 0.2s',
      fontFamily: "'DM Sans', sans-serif",
    }}>{children}</button>
  );
}

// ─── FILE DROP ZONE ─────────────────────────────────────────────
function FileDropZone({ onFilesProcessed }) {
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [manualEntry, setManualEntry] = useState(false);
  const [manualText, setManualText] = useState('');
  const inputRef = useRef();
  
  const processFiles = useCallback(async (fileList) => {
    setProcessing(true);
    const allTrades = [];
    const fileNames = [];
    
    for (const file of fileList) {
      const text = await file.text();
      const platform = file.name.replace(/\.(csv|tsv|txt)$/i, '').replace(/[_-]/g, ' ');
      const rows = parseCSV(text);
      const trades = normalizeTrades(rows, platform);
      allTrades.push(...trades);
      fileNames.push({ name: file.name, trades: trades.length, total: rows.length });
    }
    
    setFiles(fileNames);
    setProcessing(false);
    if (allTrades.length > 0) onFilesProcessed(allTrades);
  }, [onFilesProcessed]);
  
  const processManual = () => {
    if (!manualText.trim()) return;
    setProcessing(true);
    const rows = parseCSV(manualText);
    const trades = normalizeTrades(rows, 'Manual Entry');
    setProcessing(false);
    if (trades.length > 0) {
      setFiles([{ name: 'Manual entry', trades: trades.length, total: rows.length }]);
      onFilesProcessed(trades);
    }
  };
  
  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? COLORS.accent : COLORS.border}`,
          borderRadius: 16,
          padding: '48px 32px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragging ? COLORS.accentDim : 'transparent',
          transition: 'all 0.3s',
        }}
      >
        <input ref={inputRef} type="file" accept=".csv,.tsv,.txt" multiple style={{ display: 'none' }}
          onChange={e => processFiles(e.target.files)} />
        <div style={{ fontSize: 40, marginBottom: 12 }}>↑</div>
        <div style={{ fontSize: 17, fontWeight: 600, color: COLORS.text, marginBottom: 6 }}>
          Drop your trade CSV files here
        </div>
        <div style={{ fontSize: 13, color: COLORS.textMuted, lineHeight: 1.6 }}>
          Supports exports from Robinhood, Schwab, Fidelity, TD Ameritrade, E*Trade, Webull, and more.
          <br/>CSV, TSV, or TXT — messy data is fine, the parser is flexible.
        </div>
        {processing && <div style={{ marginTop: 16, color: COLORS.accent }}>Processing...</div>}
      </div>
      
      <div style={{ textAlign: 'center', margin: '16px 0' }}>
        <button onClick={() => setManualEntry(!manualEntry)} style={{
          background: 'none', border: 'none', color: COLORS.textMuted, fontSize: 13, cursor: 'pointer', textDecoration: 'underline'
        }}>
          {manualEntry ? 'Hide' : 'Or paste CSV data directly'}
        </button>
      </div>
      
      {manualEntry && (
        <div>
          <textarea
            value={manualText}
            onChange={e => setManualText(e.target.value)}
            placeholder={"date,symbol,type,quantity,price\n2024-01-15,AAPL,BUY,10,185.50\n2024-03-20,AAPL,SELL,5,172.30"}
            style={{
              width: '100%', minHeight: 140, padding: 14, borderRadius: 10,
              background: COLORS.surface, border: `1px solid ${COLORS.border}`,
              color: COLORS.text, fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
              resize: 'vertical', boxSizing: 'border-box',
            }}
          />
          <button onClick={processManual} style={{
            marginTop: 8, padding: '10px 24px', borderRadius: 8, border: 'none',
            background: COLORS.accent, color: COLORS.bg, fontWeight: 700, fontSize: 13, cursor: 'pointer',
          }}>Parse Data</button>
        </div>
      )}
      
      {files.length > 0 && (
        <div style={{ marginTop: 16 }}>
          {files.map((f, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: COLORS.surface, borderRadius: 8, marginBottom: 4, fontSize: 13 }}>
              <span style={{ color: COLORS.text }}>{f.name}</span>
              <span style={{ color: COLORS.green }}>{f.trades} trades parsed from {f.total} rows</span>
            </div>
          ))}
        </div>
      )}

      <Card style={{ marginTop: 24, background: 'rgba(34,211,238,0.05)', borderColor: 'rgba(34,211,238,0.2)' }}>
        <div style={{ fontSize: 13, color: COLORS.accent, fontWeight: 600, marginBottom: 6 }}>Privacy First</div>
        <div style={{ fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 }}>
          All data stays in your browser. Nothing is uploaded to any server. When you close or refresh this tab, all data is gone permanently. No cookies, no local storage, no tracking.
        </div>
      </Card>
    </div>
  );
}

// ─── SAMPLE DATA ────────────────────────────────────────────────
function generateSampleData() {
  const stocks = ['AAPL', 'TSLA', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'AMD'];
  const platforms = ['Robinhood', 'Schwab', 'Fidelity', 'Webull'];
  const trades = [];
  const basePrices = { AAPL: 140, TSLA: 180, MSFT: 300, NVDA: 250, AMZN: 120, GOOGL: 130, META: 280, AMD: 100 };
  
  for (let i = 0; i < 65; i++) {
    const sym = stocks[Math.floor(Math.random() * stocks.length)];
    const platform = platforms[Math.floor(Math.random() * platforms.length)];
    const d = new Date(2022, Math.floor(Math.random() * 36), Math.floor(Math.random() * 28) + 1);
    const drift = (d.getTime() - new Date(2022, 0).getTime()) / (1000*60*60*24*365) * 30;
    const price = basePrices[sym] + drift + (Math.random() - 0.5) * basePrices[sym] * 0.3;
    const qty = Math.floor(Math.random() * 20) + 1;
    trades.push({
      id: `sample-${i}`,
      symbol: sym,
      type: Math.random() > 0.45 ? 'BUY' : 'SELL',
      date: d,
      quantity: qty,
      price: Math.max(price, 10),
      total: qty * Math.max(price, 10),
      platform,
    });
  }
  return trades.sort((a, b) => a.date - b.date);
}

// ─── DASHBOARD VIEW ─────────────────────────────────────────────
function Dashboard({ trades }) {
  const [timePeriod, setTimePeriod] = useState('all');
  
  const filtered = useMemo(() => {
    if (timePeriod === 'all') return trades;
    const now = new Date();
    const cutoffs = { '1m': 30, '3m': 90, '6m': 180, '1y': 365 };
    const cutoff = new Date(now - cutoffs[timePeriod] * 86400000);
    return trades.filter(t => t.date >= cutoff);
  }, [trades, timePeriod]);
  
  const stats = useMemo(() => {
    const buys = filtered.filter(t => t.type === 'BUY');
    const sells = filtered.filter(t => t.type === 'SELL');
    const totalInvested = buys.reduce((s, t) => s + t.total, 0);
    const totalReturned = sells.reduce((s, t) => s + t.total, 0);
    const pl = totalReturned - totalInvested;
    const platforms = _.uniq(filtered.map(t => t.platform));
    const symbols = _.uniq(filtered.map(t => t.symbol));
    return { totalInvested, totalReturned, pl, platforms, symbols, buyCount: buys.length, sellCount: sells.length };
  }, [filtered]);
  
  // P&L over time
  const plTimeline = useMemo(() => {
    let cumPL = 0;
    let cumInvested = 0;
    const points = [];
    const grouped = _.groupBy(filtered, t => t.date.toISOString().slice(0, 7));
    const months = Object.keys(grouped).sort();
    for (const month of months) {
      const monthTrades = grouped[month];
      for (const t of monthTrades) {
        if (t.type === 'BUY') { cumInvested += t.total; cumPL -= t.total; }
        else { cumPL += t.total; }
      }
      points.push({ month, pl: cumPL, invested: cumInvested, label: new Date(month + '-01').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) });
    }
    return points;
  }, [filtered]);
  
  // By platform
  const platformData = useMemo(() => {
    const byPlatform = _.groupBy(filtered, 'platform');
    return Object.entries(byPlatform).map(([name, trades]) => {
      const buys = trades.filter(t => t.type === 'BUY').reduce((s, t) => s + t.total, 0);
      const sells = trades.filter(t => t.type === 'SELL').reduce((s, t) => s + t.total, 0);
      return { name, invested: buys, returned: sells, pl: sells - buys, trades: trades.length };
    }).sort((a, b) => b.trades - a.trades);
  }, [filtered]);
  
  // By symbol
  const symbolData = useMemo(() => {
    const bySymbol = _.groupBy(filtered, 'symbol');
    return Object.entries(bySymbol).map(([symbol, trades]) => {
      const buys = trades.filter(t => t.type === 'BUY');
      const sells = trades.filter(t => t.type === 'SELL');
      const invested = buys.reduce((s, t) => s + t.total, 0);
      const returned = sells.reduce((s, t) => s + t.total, 0);
      const totalQty = buys.reduce((s, t) => s + t.quantity, 0);
      return { symbol, invested, returned, pl: returned - invested, trades: trades.length, avgPrice: invested / totalQty || 0 };
    }).sort((a, b) => Math.abs(b.pl) - Math.abs(a.pl));
  }, [filtered]);
  
  return (
    <div>
      {/* Time filter */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
        {['1m','3m','6m','1y','all'].map(p => (
          <Tab key={p} active={timePeriod === p} onClick={() => setTimePeriod(p)}>{p.toUpperCase()}</Tab>
        ))}
      </div>
      
      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 24 }}>
        <Card><Stat label="Total Invested" value={fmt(stats.totalInvested, 0)} /></Card>
        <Card><Stat label="Total Returned" value={fmt(stats.totalReturned, 0)} /></Card>
        <Card><Stat label="Net P&L" value={fmt(stats.pl, 0)} color={stats.pl >= 0 ? COLORS.green : COLORS.red} /></Card>
        <Card><Stat label="Trades" value={`${stats.buyCount + stats.sellCount}`} sub={`${stats.buyCount} buys · ${stats.sellCount} sells`} /></Card>
        <Card><Stat label="Platforms" value={stats.platforms.length} sub={stats.platforms.join(', ')} /></Card>
        <Card><Stat label="Symbols" value={stats.symbols.length} /></Card>
      </div>
      
      {/* P&L Chart */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.text, marginBottom: 16 }}>Cumulative P&L Over Time</div>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={plTimeline}>
            <defs>
              <linearGradient id="plGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.accent} stopOpacity={0.3}/>
                <stop offset="100%" stopColor={COLORS.accent} stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="label" tick={{ fill: COLORS.textMuted, fontSize: 11 }} />
            <YAxis tick={{ fill: COLORS.textMuted, fontSize: 11 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
            <Tooltip contentStyle={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontSize: 12, color: COLORS.text }}
              formatter={v => fmt(v)} />
            <ReferenceLine y={0} stroke={COLORS.textDim} strokeDasharray="4 4" />
            <Area type="monotone" dataKey="pl" stroke={COLORS.accent} fill="url(#plGrad)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </Card>
      
      {/* Platform + Symbol breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.text, marginBottom: 16 }}>P&L by Platform</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={platformData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis type="number" tick={{ fill: COLORS.textMuted, fontSize: 11 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
              <YAxis type="category" dataKey="name" tick={{ fill: COLORS.textMuted, fontSize: 11 }} width={80} />
              <Tooltip contentStyle={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontSize: 12, color: COLORS.text }}
                formatter={v => fmt(v)} />
              <Bar dataKey="pl" radius={[0, 4, 4, 0]}>
                {platformData.map((d, i) => <Cell key={i} fill={d.pl >= 0 ? COLORS.green : COLORS.red} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
        
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.text, marginBottom: 16 }}>Portfolio Allocation</div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={symbolData.slice(0, 8)} dataKey="invested" nameKey="symbol" cx="50%" cy="50%"
                outerRadius={80} innerRadius={40} paddingAngle={2} strokeWidth={0}>
                {symbolData.slice(0, 8).map((_, i) => <Cell key={i} fill={COLORS.chart[i % COLORS.chart.length]} />)}
              </Pie>
              <Tooltip contentStyle={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontSize: 12, color: COLORS.text }}
                formatter={v => fmt(v)} />
              <Legend wrapperStyle={{ fontSize: 11, color: COLORS.textMuted }} />
            </PieChart>
          </ResponsiveContainer>
        </Card>
      </div>
      
      {/* Symbol Table */}
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.text, marginBottom: 16 }}>Performance by Symbol</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                {['Symbol', 'Trades', 'Invested', 'Returned', 'P&L', 'Avg Buy Price'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 12px', color: COLORS.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {symbolData.map((s, i) => (
                <tr key={s.symbol} style={{ borderBottom: `1px solid ${COLORS.border}22` }}>
                  <td style={{ padding: '10px 12px', fontWeight: 700, color: COLORS.text, fontFamily: "'JetBrains Mono', monospace" }}>{s.symbol}</td>
                  <td style={{ padding: '10px 12px', color: COLORS.textMuted }}>{s.trades}</td>
                  <td style={{ padding: '10px 12px', color: COLORS.textMuted }}>{fmt(s.invested, 0)}</td>
                  <td style={{ padding: '10px 12px', color: COLORS.textMuted }}>{fmt(s.returned, 0)}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <Badge color={s.pl >= 0 ? 'green' : 'red'}>{fmt(s.pl, 0)}</Badge>
                  </td>
                  <td style={{ padding: '10px 12px', color: COLORS.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>{fmt(s.avgPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ─── TRADES VIEW ────────────────────────────────────────────────
function TradesView({ trades }) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [filterPlatform, setFilterPlatform] = useState('all');
  const [filterType, setFilterType] = useState('all');
  
  const platforms = useMemo(() => ['all', ..._.uniq(trades.map(t => t.platform))], [trades]);
  
  const displayed = useMemo(() => {
    let result = [...trades];
    if (search) result = result.filter(t => t.symbol.includes(search.toUpperCase()) || t.platform.toLowerCase().includes(search.toLowerCase()));
    if (filterPlatform !== 'all') result = result.filter(t => t.platform === filterPlatform);
    if (filterType !== 'all') result = result.filter(t => t.type === filterType);
    result.sort((a, b) => {
      const mul = sortDir === 'asc' ? 1 : -1;
      if (sortBy === 'date') return mul * (a.date - b.date);
      if (sortBy === 'symbol') return mul * a.symbol.localeCompare(b.symbol);
      if (sortBy === 'total') return mul * (a.total - b.total);
      return 0;
    });
    return result;
  }, [trades, search, sortBy, sortDir, filterPlatform, filterType]);
  
  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  };
  
  return (
    <Card>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search symbol or platform..."
          style={{ padding: '8px 14px', borderRadius: 8, border: `1px solid ${COLORS.border}`, background: COLORS.bg, color: COLORS.text, fontSize: 13, flex: '1 1 200px', fontFamily: "'DM Sans', sans-serif" }} />
        <select value={filterPlatform} onChange={e => setFilterPlatform(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${COLORS.border}`, background: COLORS.bg, color: COLORS.text, fontSize: 13 }}>
          {platforms.map(p => <option key={p} value={p}>{p === 'all' ? 'All Platforms' : p}</option>)}
        </select>
        <select value={filterType} onChange={e => setFilterType(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${COLORS.border}`, background: COLORS.bg, color: COLORS.text, fontSize: 13 }}>
          <option value="all">All Types</option>
          <option value="BUY">Buys Only</option>
          <option value="SELL">Sells Only</option>
        </select>
        <div style={{ fontSize: 12, color: COLORS.textMuted }}>{displayed.length} trades</div>
      </div>
      
      <div style={{ overflowX: 'auto', maxHeight: 520, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ position: 'sticky', top: 0, background: COLORS.surface, zIndex: 1 }}>
            <tr style={{ borderBottom: `1px solid ${COLORS.border}` }}>
              {[['date','Date'],['symbol','Symbol'],['type','Type'],['qty','Qty'],['price','Price'],['total','Total'],['platform','Platform']].map(([k,l]) => (
                <th key={k} onClick={() => ['date','symbol','total'].includes(k) ? toggleSort(k) : null}
                  style={{ textAlign: 'left', padding: '10px 12px', color: COLORS.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, cursor: ['date','symbol','total'].includes(k) ? 'pointer' : 'default', userSelect: 'none' }}>
                  {l} {sortBy === k ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayed.map(t => (
              <tr key={t.id} style={{ borderBottom: `1px solid ${COLORS.border}15` }}>
                <td style={{ padding: '9px 12px', color: COLORS.textMuted, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{fmtDate(t.date)}</td>
                <td style={{ padding: '9px 12px', fontWeight: 700, color: COLORS.text, fontFamily: "'JetBrains Mono', monospace" }}>{t.symbol}</td>
                <td style={{ padding: '9px 12px' }}><Badge color={t.type === 'BUY' ? 'green' : 'red'}>{t.type}</Badge></td>
                <td style={{ padding: '9px 12px', color: COLORS.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>{t.quantity}</td>
                <td style={{ padding: '9px 12px', color: COLORS.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>{fmt(t.price)}</td>
                <td style={{ padding: '9px 12px', color: COLORS.text, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{fmt(t.total)}</td>
                <td style={{ padding: '9px 12px', color: COLORS.textMuted, fontSize: 12 }}>{t.platform}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── SIMULATOR VIEW ─────────────────────────────────────────────
function SimulatorView({ trades }) {
  const symbols = useMemo(() => _.uniq(trades.map(t => t.symbol)).sort(), [trades]);
  const [selectedSymbol, setSelectedSymbol] = useState(symbols[0] || '');
  const [altSymbol, setAltSymbol] = useState('');
  const [altPriceMultiplier, setAltPriceMultiplier] = useState(1.5);
  
  const holdSim = useMemo(() => {
    if (!selectedSymbol) return null;
    return simulateHoldStrategy(trades, selectedSymbol);
  }, [trades, selectedSymbol]);
  
  // Timeline for the selected symbol
  const timeline = useMemo(() => {
    if (!selectedSymbol) return [];
    const st = trades.filter(t => t.symbol === selectedSymbol);
    let held = 0, spent = 0, realized = 0;
    return st.map(t => {
      if (t.type === 'BUY') { held += t.quantity; spent += t.total; }
      else { held -= t.quantity; realized += t.total; }
      return {
        date: fmtDate(t.date),
        held,
        currentValue: held * t.price,
        realizedPL: realized - spent,
        holdValue: (spent > 0 ? (held * t.price + realized) : 0),
        action: t.type,
      };
    });
  }, [trades, selectedSymbol]);
  
  // Alternative investment simulation
  const altSim = useMemo(() => {
    if (!selectedSymbol || !altSymbol) return null;
    const st = trades.filter(t => t.symbol === selectedSymbol);
    const totalInvested = st.filter(t => t.type === 'BUY').reduce((s, t) => s + t.total, 0);
    const totalReturned = st.filter(t => t.type === 'SELL').reduce((s, t) => s + t.total, 0);
    const actualPL = totalReturned - totalInvested;
    
    // Simulate alt: assume alt stock grows by the multiplier
    const altPL = totalInvested * (altPriceMultiplier - 1);
    
    return {
      actual: { symbol: selectedSymbol, invested: totalInvested, pl: actualPL },
      alt: { symbol: altSymbol, invested: totalInvested, pl: altPL },
      difference: altPL - actualPL,
    };
  }, [trades, selectedSymbol, altSymbol, altPriceMultiplier]);
  
  if (symbols.length === 0) return <Card><div style={{ color: COLORS.textMuted, textAlign: 'center', padding: 40 }}>No trades to simulate</div></Card>;
  
  return (
    <div>
      {/* Symbol selector */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.text, marginBottom: 12 }}>Select a Stock to Simulate</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {symbols.map(s => (
            <button key={s} onClick={() => setSelectedSymbol(s)} style={{
              padding: '6px 14px', borderRadius: 8, border: `1px solid ${selectedSymbol === s ? COLORS.accent : COLORS.border}`,
              background: selectedSymbol === s ? COLORS.accentDim : 'transparent',
              color: selectedSymbol === s ? COLORS.accent : COLORS.textMuted,
              fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace",
            }}>{s}</button>
          ))}
        </div>
      </Card>
      
      {/* Hold Strategy */}
      {holdSim && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.text, marginBottom: 16 }}>
            What If You Never Sold {selectedSymbol}?
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16, marginBottom: 20 }}>
            <Stat label="Total Shares Bought" value={holdSim.totalBought} />
            <Stat label="Avg Buy Price" value={fmt(holdSim.avgBuyPrice)} />
            <Stat label="Last Known Price" value={fmt(holdSim.lastKnownPrice)} />
            <Stat label="Actual P&L" value={fmt(holdSim.actualPL, 0)} color={holdSim.actualPL >= 0 ? COLORS.green : COLORS.red} />
            <Stat label="Hold P&L (estimated)" value={fmt(holdSim.holdPL, 0)} color={holdSim.holdPL >= 0 ? COLORS.green : COLORS.red} />
            <Stat label="Difference" value={fmt(holdSim.difference, 0)} color={holdSim.difference >= 0 ? COLORS.green : COLORS.red}
              sub={holdSim.difference >= 0 ? 'You would have made more holding' : 'Selling was the better move'} />
          </div>
          
          {timeline.length > 0 && (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={timeline}>
                <defs>
                  <linearGradient id="holdGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.green} stopOpacity={0.2}/>
                    <stop offset="100%" stopColor={COLORS.green} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                <XAxis dataKey="date" tick={{ fill: COLORS.textMuted, fontSize: 10 }} />
                <YAxis tick={{ fill: COLORS.textMuted, fontSize: 11 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
                <Tooltip contentStyle={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontSize: 12, color: COLORS.text }}
                  formatter={v => fmt(v)} />
                <Area type="monotone" dataKey="currentValue" stroke={COLORS.accent} fill="url(#holdGrad)" strokeWidth={2} name="Portfolio Value" />
                <Area type="monotone" dataKey="realizedPL" stroke={COLORS.orange} fill="none" strokeWidth={1.5} strokeDasharray="4 4" name="Realized P&L" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>
      )}
      
      {/* Alternative Investment */}
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.text, marginBottom: 16 }}>
          What If You'd Bought Something Else?
        </div>
        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'end' }}>
          <div>
            <label style={{ fontSize: 11, color: COLORS.textMuted, display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Alternative Stock
            </label>
            <input value={altSymbol} onChange={e => setAltSymbol(e.target.value.toUpperCase())} placeholder="e.g. MSFT"
              style={{ padding: '8px 14px', borderRadius: 8, border: `1px solid ${COLORS.border}`, background: COLORS.bg, color: COLORS.text, fontSize: 14, width: 120, fontFamily: "'JetBrains Mono', monospace" }} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: COLORS.textMuted, display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Est. Growth Multiplier
            </label>
            <input type="range" min="0.2" max="5" step="0.1" value={altPriceMultiplier} onChange={e => setAltPriceMultiplier(+e.target.value)}
              style={{ width: 160, accentColor: COLORS.accent }} />
            <span style={{ marginLeft: 8, fontSize: 14, fontWeight: 700, color: COLORS.accent, fontFamily: "'JetBrains Mono', monospace" }}>
              {altPriceMultiplier.toFixed(1)}×
            </span>
          </div>
        </div>
        <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 16 }}>
          This simulates putting the same money into {altSymbol || '___'} instead. Set the growth multiplier to the stock's actual performance 
          (e.g., 2.0× means it doubled). Since we're keeping all data local and not fetching live prices, you provide the estimate.
        </div>
        
        {altSim && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <Card style={{ background: COLORS.bg }}>
              <Stat label={`Actual (${altSim.actual.symbol})`} value={fmt(altSim.actual.pl, 0)} color={altSim.actual.pl >= 0 ? COLORS.green : COLORS.red}
                sub={`on ${fmt(altSim.actual.invested, 0)} invested`} />
            </Card>
            <Card style={{ background: COLORS.bg }}>
              <Stat label={`Alternative (${altSim.alt.symbol})`} value={fmt(altSim.alt.pl, 0)} color={altSim.alt.pl >= 0 ? COLORS.green : COLORS.red}
                sub={`on ${fmt(altSim.alt.invested, 0)} invested`} />
            </Card>
            <Card style={{ background: altSim.difference >= 0 ? COLORS.redDim : COLORS.greenDim }}>
              <Stat label="Difference" value={fmt(Math.abs(altSim.difference), 0)}
                color={altSim.difference >= 0 ? COLORS.red : COLORS.green}
                sub={altSim.difference >= 0 ? `You missed out by switching` : `Your pick was better!`} />
            </Card>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── MAIN APP ───────────────────────────────────────────────────
export default function App() {
  const [trades, setTrades] = useState([]);
  const [view, setView] = useState('upload');
  const [usingSample, setUsingSample] = useState(false);
  
  const handleData = useCallback((newTrades) => {
    setTrades(prev => {
      const combined = [...prev, ...newTrades];
      return _.uniqBy(combined, t => `${t.symbol}-${t.date.toISOString()}-${t.type}-${t.quantity}`);
    });
    setView('dashboard');
  }, []);
  
  const loadSample = () => {
    setTrades(generateSampleData());
    setUsingSample(true);
    setView('dashboard');
  };
  
  const clearAll = () => {
    setTrades([]);
    setUsingSample(false);
    setView('upload');
  };
  
  return (
    <div style={{
      minHeight: '100vh',
      background: COLORS.bg,
      color: COLORS.text,
      fontFamily: "'DM Sans', sans-serif",
      padding: '0 16px 40px',
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&family=Instrument+Serif&display=swap" rel="stylesheet" />
      
      {/* Header */}
      <div style={{ maxWidth: 1100, margin: '0 auto', paddingTop: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
          <div>
            <h1 style={{
              fontSize: 28,
              fontWeight: 400,
              fontFamily: "'Instrument Serif', serif",
              margin: 0,
              color: COLORS.text,
              letterSpacing: '-0.02em',
            }}>
              Phantom Portfolio
            </h1>
            <p style={{ fontSize: 12, color: COLORS.textMuted, margin: '4px 0 0', letterSpacing: '0.04em' }}>
              PRIVATE TRADE ANALYSIS · ZERO DATA RETENTION
            </p>
          </div>
          
          {trades.length > 0 && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <Tab active={view === 'dashboard'} onClick={() => setView('dashboard')}>Dashboard</Tab>
              <Tab active={view === 'trades'} onClick={() => setView('trades')}>Trades</Tab>
              <Tab active={view === 'simulator'} onClick={() => setView('simulator')}>What If?</Tab>
              <Tab active={view === 'upload'} onClick={() => setView('upload')}>Add Data</Tab>
              <div style={{ width: 1, height: 24, background: COLORS.border, margin: '0 8px' }} />
              <button onClick={clearAll} style={{
                padding: '6px 12px', borderRadius: 8, border: `1px solid ${COLORS.red}33`,
                background: COLORS.redDim, color: COLORS.red, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}>Clear All</button>
            </div>
          )}
        </div>
        
        {usingSample && (
          <div style={{
            padding: '8px 16px', borderRadius: 8, background: 'rgba(245,158,11,0.1)',
            border: '1px solid rgba(245,158,11,0.2)', marginBottom: 16, fontSize: 12, color: COLORS.orange,
          }}>
            Viewing sample data. Upload your own CSVs to replace it.
          </div>
        )}
        
        {/* Views */}
        {view === 'upload' && (
          <div style={{ paddingTop: 40 }}>
            <FileDropZone onFilesProcessed={handleData} />
            {trades.length === 0 && (
              <div style={{ textAlign: 'center', marginTop: 24 }}>
                <button onClick={loadSample} style={{
                  padding: '10px 24px', borderRadius: 8, border: `1px solid ${COLORS.border}`,
                  background: 'transparent', color: COLORS.textMuted, fontSize: 13, cursor: 'pointer',
                  fontFamily: "'DM Sans', sans-serif",
                }}>
                  Load sample data to explore
                </button>
              </div>
            )}
          </div>
        )}
        
        {view === 'dashboard' && trades.length > 0 && <Dashboard trades={trades} />}
        {view === 'trades' && trades.length > 0 && <TradesView trades={trades} />}
        {view === 'simulator' && trades.length > 0 && <SimulatorView trades={trades} />}
      </div>
    </div>
  );
}