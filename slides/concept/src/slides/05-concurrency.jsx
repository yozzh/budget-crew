import { AccentRule } from '@/components/SlideTransition';

// Shape of one purchase check: Parser, then four advisers in parallel, then Judge.
// x positions are relative (0-100), not measured seconds.
const LANES = [
  { id: 'parser', name: 'Parser', from: 0, to: 14, tone: 'ink' },
  { id: 'impact', name: 'Impact', from: 16, to: 52, tone: 'accent' },
  { id: 'obligations', name: 'Obligations', from: 16, to: 47, tone: 'accent' },
  { id: 'deal', name: 'Deal Check', from: 16, to: 66, tone: 'accent' },
  { id: 'alternatives', name: 'Alternatives', from: 16, to: 60, tone: 'accent' },
  { id: 'judge', name: 'Judge', from: 68, to: 100, tone: 'ink' },
];

export default function Concurrency() {
  const W = 1136, label = 150, laneH = 46, top = 34, track = W - label - 20;
  const x = (v) => label + (v / 100) * track;
  const H = top + LANES.length * laneH + 10;
  return (
    <div className="slide-page flex flex-col" data-viz-id="s5">
      <header className="shrink-0">
        <span data-viz-id="s5.eyebrow" className="text-eyebrow tracking-eyebrow uppercase font-bold text-primary-500">Genuine concurrency</span>
        <h2 data-viz-id="s5.title" className="mt-3 text-h1 font-display font-bold text-text-primary">
          One question, <span className="text-primary-500">four advisers at once</span>
        </h2>
        <AccentRule className="mt-5" data-viz-id="s5.rule" />
      </header>
      <div className="flex-1 min-h-0 mt-8 flex flex-col justify-center" data-viz-id="s5.diagram">
        <p data-viz-id="s5.question" className="text-lead font-medium text-text-primary">“Can I buy a Nintendo Switch for €279?”</p>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="mt-4 w-full" role="img"
          aria-label="Parser runs first, then Impact, Obligations, Deal Check and Alternatives run at the same time, then Judge decides">
          <rect x={x(16)} y={top - 24} width={x(66) - x(16)} height={4 * laneH + 30} rx="10" fill="var(--color-accent-soft)" />
          <text x={x(16) + 12} y={top - 8} fontSize="12" fontWeight="700" fill="var(--text-accent)">4 Mozaik loops running at the same time</text>
          {LANES.map((l, i) => {
            const y = top + 14 + i * laneH;
            return (
              <g key={l.id}>
                <text x="0" y={y + 19} fontSize="15" fontWeight="700" fill="var(--text-primary)" fontFamily="var(--font-display)">{l.name}</text>
                <line x1={label} y1={y + 14} x2={W - 20} y2={y + 14} stroke="var(--ink-200)" strokeWidth="1" />
                <rect x={x(l.from)} y={y + 2} width={x(l.to) - x(l.from)} height="24" rx="12"
                  fill={l.tone === 'accent' ? 'var(--color-accent)' : 'var(--ink-700)'} />
              </g>
            );
          })}
        </svg>
      </div>
      <div className="shrink-0 mt-6 grid grid-cols-3 gap-8">
        <p data-viz-id="s5.point.events" className="text-body text-text-secondary"><b className="text-text-primary">No orchestrator.</b> Each agent subscribes to the event it cares about and starts its own loop.</p>
        <p data-viz-id="s5.point.ledger" className="text-body text-text-secondary"><b className="text-text-primary">One writer.</b> Agents only answer; the Ledger stores each verdict in its own slot.</p>
        <p data-viz-id="s5.point.judge" className="text-body text-text-secondary"><b className="text-text-primary">Judge waits</b> for all four slots, or a deadline for a stuck one, then decides.</p>
      </div>
    </div>
  );
}
