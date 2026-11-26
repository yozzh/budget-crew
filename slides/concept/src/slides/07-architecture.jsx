import { AccentRule } from '@/components/SlideTransition';

function Box({ x, y, w, h, title, sub, kind }) {
  const fill = kind === 'ours' ? 'var(--color-accent-soft)' : 'var(--surface-muted)';
  const stroke = kind === 'ours' ? 'var(--color-accent)' : 'var(--ink-700)';
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="12" fill={fill} stroke={stroke} strokeWidth="1.5" />
      <text x={x + w / 2} y={y + h / 2 - 4} textAnchor="middle" fontSize="18" fontWeight="700" fontFamily="var(--font-display)" fill="var(--text-primary)">{title}</text>
      <text x={x + w / 2} y={y + h / 2 + 18} textAnchor="middle" fontSize="13" fill="var(--text-secondary)">{sub}</text>
    </g>
  );
}

// Orthogonal or straight connector through the given points, with a polygon head at the end.
function Path({ points, label, lx, ly }) {
  const [x2, y2] = points[points.length - 1], [x1, y1] = points[points.length - 2];
  const a = Math.atan2(y2 - y1, x2 - x1), s = 9;
  const p = (t) => `${x2 - s * Math.cos(a + t)},${y2 - s * Math.sin(a + t)}`;
  return (
    <g>
      <polyline points={points.map((pt) => pt.join(',')).join(' ')} fill="none" stroke="var(--ink-500)" strokeWidth="1.5" />
      <polygon points={`${x2},${y2} ${p(0.45)} ${p(-0.45)}`} fill="var(--ink-500)" />
      {label && <text x={lx} y={ly} textAnchor="middle" fontSize="12" fill="var(--text-muted)">{label}</text>}
    </g>
  );
}

const LOOPS = ['Parser', 'Pace · Anomaly · Coach', 'Impact · Obligations', 'Deal Check · Alternatives', 'Judge'];

export default function Architecture() {
  return (
    <div className="slide-page flex flex-col" data-viz-id="s7">
      <header className="shrink-0">
        <span data-viz-id="s7.eyebrow" className="text-eyebrow tracking-eyebrow uppercase font-bold text-primary-500">How it works</span>
        <h2 data-viz-id="s7.title" className="mt-3 text-h1 font-display font-bold text-text-primary">Code counts the money, agents explain it</h2>
        <AccentRule className="mt-5" data-viz-id="s7.rule" />
      </header>
      <div className="flex-1 min-h-0 mt-4 flex items-center" data-viz-id="s7.diagram">
        <svg viewBox="0 0 1136 356" width="1136" height="356" className="w-full" role="img"
          aria-label="The app sends text to the Ledger; the Ledger emits events to agent loops on the Mozaik runtime; agents answer with verdicts; the Ledger publishes state through Centrifugo back to the app">
          <Box x={0} y={110} w={170} h={90} title="App" sub="types free text" kind="ext" />
          <Box x={250} y={110} w={220} h={90} title="Ledger" sub="only writer · budget math" kind="ours" />
          <rect x={560} y={4} width={330} height={300} rx="16" fill="var(--surface-card)" stroke="var(--border-default)" strokeDasharray="6 6" />
          <text x={576} y={28} fontSize="13" fontWeight="700" fill="var(--text-secondary)">Mozaik runtime · one loop per agent</text>
          {LOOPS.map((t, i) => (
            <g key={t}>
              <rect x={584} y={42 + i * 51} width={282} height={40} rx="10" fill="var(--color-accent-soft)" stroke="var(--color-accent)" />
              <text x={725} y={67 + i * 51} textAnchor="middle" fontSize="15" fontWeight="700" fill="var(--text-primary)">{t}</text>
            </g>
          ))}
          <Box x={966} y={110} w={170} h={90} title="Centrifugo" sub="live to every screen" kind="ext" />
          <Path points={[[170, 155], [248, 155]]} label="HTTP 202" lx={209} ly={145} />
          <Path points={[[470, 130], [558, 130]]} label="events" lx={514} ly={120} />
          <Path points={[[560, 180], [472, 180]]} label="verdicts" lx={514} ly={198} />
          <Path points={[[360, 200], [360, 322], [1031, 322], [1031, 202]]} label="state and every agent phase" lx={705} ly={316} />
          <Path points={[[1091, 200], [1091, 350], [85, 350], [85, 202]]} label="live updates" lx={705} ly={344} />
        </svg>
      </div>
      <div className="shrink-0 mt-4 grid grid-cols-3 gap-8">
        <p data-viz-id="s7.point.math" className="text-body text-text-secondary"><b className="text-text-primary">Deterministic math.</b> Allowance, periods and what-ifs are tested pure functions; agents get numbers only through tools.</p>
        <p data-viz-id="s7.point.context" className="text-body text-text-secondary"><b className="text-text-primary">Fresh context per loop.</b> Parallel loops of one agent never share memory.</p>
        <p data-viz-id="s7.point.live" className="text-body text-text-secondary"><b className="text-text-primary">Live by default.</b> Every phase of every agent streams to the screen as it happens.</p>
      </div>
    </div>
  );
}
