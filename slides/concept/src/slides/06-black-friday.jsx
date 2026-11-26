import { AccentRule } from '@/components/SlideTransition';

// Figures: simulateBudget on the synthetic November (seed/month.json) on 27 Nov,
// €300 left, €75 today, 4 days; 90-day lows from seed/price-history.json.
const CASES = [
  { id: 'buy', decision: 'Buy', tone: 'text-status-positive', item: 'Instant Pot, €49', why: 'A real discount that fits.',
    facts: ['Half its 90-day low of €102', '€251 left after it', 'Tomorrow: €83.67'] },
  { id: 'wait', decision: 'Wait', tone: 'text-status-warning', item: 'Nintendo Switch, €279', why: 'Fair price, empties the week.',
    facts: ['Not below its 90-day low', '€21 left for 4 days', 'Tomorrow: €7.00'] },
  { id: 'skip', decision: 'Skip', tone: 'text-status-danger', item: 'PlayStation 5, €399', why: 'The month ends in the red.',
    facts: ['More than is left this month', 'Period ends at −€99', 'Tomorrow: −€33.00'] },
];

export default function BlackFriday() {
  return (
    <div className="slide-page flex flex-col" data-viz-id="s6">
      <header className="shrink-0">
        <span data-viz-id="s6.eyebrow" className="text-eyebrow tracking-eyebrow uppercase font-bold text-primary-500">Black Friday</span>
        <h2 data-viz-id="s6.title" className="mt-3 text-h1 font-display font-bold text-text-primary">Is it a real deal, and can I afford it?</h2>
        <AccentRule className="mt-5" data-viz-id="s6.rule" />
      </header>
      <div className="flex-1 min-h-0 mt-8 grid grid-cols-3 gap-6 items-stretch">
        {CASES.map((c) => (
          <div key={c.id} data-viz-id={`s6.case.${c.id}`} className="bg-bg-card border border-border-subtle rounded-lg shadow-sm p-7 flex flex-col">
            <p className="text-body text-text-secondary">Can I buy <b className="text-text-primary">{c.item}</b>?</p>
            <p data-viz-id={`s6.case.${c.id}.decision`} className={`mt-5 text-[80px] leading-none font-display font-bold ${c.tone}`}>{c.decision}</p>
            <p data-viz-id={`s6.case.${c.id}.why`} className="mt-4 text-lead font-medium text-text-primary">{c.why}</p>
            <ul className="mt-auto pt-6 flex flex-col gap-2 border-t border-border-subtle">
              {c.facts.map((f) => <li key={f} className="text-body text-text-primary">{f}</li>)}
            </ul>
          </div>
        ))}
      </div>
      <p data-viz-id="s6.note" className="shrink-0 mt-5 text-small text-text-muted">
        Alex on 27 November: €300 left, €75 for today, 4 days to payday. Budget math by code; the decision and its wording by Judge.
      </p>
    </div>
  );
}
