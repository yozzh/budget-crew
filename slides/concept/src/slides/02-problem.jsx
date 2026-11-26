export default function Problem() {
  const pains = [
    ['p1', 'A monthly budget shows the month, not today.'],
    ['p2', 'Banking apps show what already happened.'],
    ['p3', 'Sales pressure you to decide in minutes.'],
  ];
  const gains = [
    ['g1', 'One number: what you can spend today.'],
    ['g2', 'Every expense re-plans the days left.'],
    ['g3', 'Ask before you buy and get a reasoned answer.'],
  ];
  return (
    <div className="slide-page !p-0 !grid grid-cols-2" data-viz-id="s2">
      <div data-viz-id="s2.problem" className="bg-bg-ink p-slide-margin flex flex-col justify-center">
        <span data-viz-id="s2.problem.eyebrow" className="text-eyebrow tracking-eyebrow uppercase font-bold text-ink-300">The problem</span>
        <h2 data-viz-id="s2.problem.title" className="mt-4 text-h1 font-display font-bold text-text-inverse">
          It is 6 pm. Can I spend €40 today?
        </h2>
        <div className="mt-10 flex flex-col gap-6">
          {pains.map(([id, t]) => (
            <p key={id} data-viz-id={`s2.${id}`} className="text-lead font-light text-ink-200 border-l-2 border-ink-600 pl-5">{t}</p>
          ))}
        </div>
      </div>
      <div data-viz-id="s2.solution" className="bg-bg-card p-slide-margin flex flex-col justify-center">
        <span data-viz-id="s2.solution.eyebrow" className="text-eyebrow tracking-eyebrow uppercase font-bold text-primary-500">Budget Crew</span>
        <h2 data-viz-id="s2.solution.title" className="mt-4 text-h1 font-display font-bold text-text-primary">
          Know your number, <span className="text-primary-500">then decide</span>
        </h2>
        <div className="mt-10 flex flex-col gap-6">
          {gains.map(([id, t]) => (
            <p key={id} data-viz-id={`s2.${id}`} className="text-lead font-medium text-text-primary border-l-2 border-border-accent pl-5">{t}</p>
          ))}
        </div>
      </div>
    </div>
  );
}
