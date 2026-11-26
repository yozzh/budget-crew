import { AccentRule } from '@/components/SlideTransition';

const STEPS = [
  { id: 'salary', label: 'Salary opens a period', value: '€2,500' },
  { id: 'bills', label: 'Bills are reserved first', value: '− €1,100' },
  { id: 'daily', label: 'The rest, split by day', value: '€46.67 / day' },
  { id: 'replan', label: 'Each expense re-plans the days left', value: 'every euro' },
];

export default function Idea() {
  return (
    <div className="slide-page flex flex-col" data-viz-id="s3">
      <header className="shrink-0">
        <span data-viz-id="s3.eyebrow" className="text-eyebrow tracking-eyebrow uppercase font-bold text-primary-500">The idea</span>
        <h2 data-viz-id="s3.title" className="mt-3 text-h1 font-display font-bold text-text-primary">One number you can act on</h2>
        <AccentRule className="mt-5" data-viz-id="s3.rule" />
      </header>
      <div className="flex-1 min-h-0 grid grid-cols-[1.05fr_0.95fr] gap-16 items-center">
        <div data-viz-id="s3.hero">
          <p data-viz-id="s3.hero.label" className="text-eyebrow tracking-eyebrow uppercase font-bold text-text-muted">Alex, Black Friday morning</p>
          <p data-viz-id="s3.hero.value" className="mt-2 text-[168px] leading-none font-display font-bold tracking-tight text-primary-500">€75</p>
          <p data-viz-id="s3.hero.caption" className="mt-4 text-lead text-text-secondary">for today · €300 left · 4 days to payday</p>
        </div>
        <ol data-viz-id="s3.steps" className="flex flex-col gap-3">
          {STEPS.map((s, i) => (
            <li key={s.id} data-viz-id={`s3.step.${s.id}`} className="flex items-center justify-between bg-bg-card border border-border-subtle rounded-lg shadow-sm px-6 py-4">
              <span className="flex items-center gap-4">
                <span className="w-8 h-8 rounded-pill bg-primary-50 text-primary-600 text-small font-bold flex items-center justify-center">{i + 1}</span>
                <span className="text-body text-text-primary">{s.label}</span>
              </span>
              <span className="text-body font-bold text-text-primary">{s.value}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
