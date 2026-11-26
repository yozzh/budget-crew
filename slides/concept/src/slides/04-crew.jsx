import { AccentRule } from '@/components/SlideTransition';

const CREW = [
  ['parser', 'Parser', 'Pr', 'Reads free text', 'luna'],
  ['planner', 'Planner', 'Pl', 'Plans the period', 'terra'],
  ['obligations', 'Obligations', 'Ob', 'Guards the bills', 'terra'],
  ['pace', 'Pace', 'Pc', 'On pace or not', 'terra'],
  ['anomaly', 'Anomaly', 'An', 'Spots unusual spend', 'terra'],
  ['coach', 'Coach', 'Co', 'One line of advice', 'sol'],
  ['impact', 'Impact', 'Im', 'Before and after', 'terra'],
  ['deal', 'Deal Check', 'DC', 'Is the discount real?', 'terra'],
  ['alternatives', 'Alternatives', 'Al', 'Cheaper or later', 'terra'],
  ['judge', 'Judge', 'Ju', 'Buy, wait or skip', 'sol'],
];

export default function Crew() {
  return (
    <div className="slide-page flex flex-col" data-viz-id="s4">
      <header className="shrink-0">
        <span data-viz-id="s4.eyebrow" className="text-eyebrow tracking-eyebrow uppercase font-bold text-primary-500">The crew</span>
        <h2 data-viz-id="s4.title" className="mt-3 text-h1 font-display font-bold text-text-primary">Ten specialists, one shared budget</h2>
        <AccentRule className="mt-5" data-viz-id="s4.rule" />
      </header>
      <div className="flex-1 min-h-0 mt-8 grid grid-cols-5 grid-rows-2 gap-4">
        {CREW.map(([id, name, glyph, role, tier]) => (
          <div key={id} data-viz-id={`s4.agent.${id}`} className={`rounded-lg border p-5 flex flex-col ${id === 'judge' ? 'bg-primary-50 border-border-accent' : 'bg-bg-card border-border-subtle shadow-sm'}`}>
            <span className="w-11 h-11 rounded-pill bg-bg-ink text-text-inverse font-display font-bold text-body flex items-center justify-center">{glyph}</span>
            <p className="mt-4 text-h3 font-display font-bold text-text-primary">{name}</p>
            <p className="mt-1 text-small text-text-secondary">{role}</p>
            <p className="mt-auto text-footnote uppercase tracking-eyebrow font-bold text-text-muted">{tier}</p>
          </div>
        ))}
      </div>
      <p data-viz-id="s4.note" className="shrink-0 mt-5 text-small text-text-muted">
        Model tiers: luna parses, terra handles routine checks, sol coaches and judges. The money itself is computed by code.
      </p>
    </div>
  );
}
