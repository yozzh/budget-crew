import { AccentRule } from '@/components/SlideTransition';

// Month-end balances of the closed periods in seed/history.json (euro, rounded).
// Moments are the purchase checks Judge answered that month.
const MONTHS = [
  { id: 'jun', label: 'Jun', balance: 581, event: 'Bike €340', decision: 'Wait' },
  { id: 'jul', label: 'Jul', balance: 734, event: 'Side gig +€220 · lamp €39', decision: 'Buy' },
  { id: 'aug', label: 'Aug', balance: -794, event: 'Holiday · tablet €459', decision: 'Skip' },
  { id: 'sep', label: 'Sep', balance: -498, event: 'Repair · new phone €699', decision: 'Skip' },
  { id: 'oct', label: 'Oct', balance: 214, event: 'Headphones €79', decision: 'Buy' },
];

export default function History() {
  const W = 1136, H = 300, zero = 150, scale = 130 / 800, col = W / MONTHS.length, bw = 96;
  return (
    <div className="slide-page flex flex-col" data-viz-id="s8">
      <header className="shrink-0">
        <span data-viz-id="s8.eyebrow" className="text-eyebrow tracking-eyebrow uppercase font-bold text-primary-500">Five months with Alex</span>
        <h2 data-viz-id="s8.title" className="mt-3 text-h1 font-display font-bold text-text-primary">
          One bad August, <span className="text-primary-500">back in the black by October</span>
        </h2>
        <AccentRule className="mt-5" data-viz-id="s8.rule" />
      </header>
      <div className="flex-1 min-h-0 mt-6 flex flex-col justify-center" data-viz-id="s8.chart">
        <p data-viz-id="s8.chart.label" className="text-eyebrow tracking-eyebrow uppercase font-bold text-text-muted">Balance at the end of each month</p>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="mt-2 w-full" role="img"
          aria-label="Month-end balance: June +581, July +734, August -794, September -498, October +214 euros">
          <line x1="0" y1={zero} x2={W} y2={zero} stroke="var(--ink-300)" strokeWidth="1" />
          {MONTHS.map((m, i) => {
            const h = Math.abs(m.balance) * scale, x = i * col + (col - bw) / 2, up = m.balance >= 0;
            const fill = up ? 'var(--color-accent)' : 'var(--status-danger)';
            return (
              <g key={m.id}>
                <rect x={x} y={up ? zero - h : zero} width={bw} height={h} rx="6" fill={fill} />
                <text x={x + bw / 2} y={up ? zero - h - 10 : zero + h + 22} textAnchor="middle" fontSize="18" fontWeight="700"
                  fontFamily="var(--font-display)" fill={fill}>{up ? '+' : '−'}€{Math.abs(m.balance)}</text>
                <text x={x + bw / 2} y={up ? zero + 22 : zero - 10} textAnchor="middle" fontSize="14" fontWeight="700" fill="var(--text-secondary)">{m.label}</text>
              </g>
            );
          })}
        </svg>
        <div className="mt-4 grid grid-cols-5" data-viz-id="s8.moments">
          {MONTHS.map((m) => (
            <div key={m.id} data-viz-id={`s8.moment.${m.id}`} className="px-3 text-center">
              <p className="text-small text-text-secondary">{m.event}</p>
              <p className="mt-1 text-small font-bold text-text-primary">Judge: {m.decision}</p>
            </div>
          ))}
        </div>
      </div>
      <p data-viz-id="s8.note" className="shrink-0 mt-4 text-small text-text-muted">
        Synthetic history: about 140 expenses a month and 29 answered requests, every balance computed by the budget code.
      </p>
    </div>
  );
}
