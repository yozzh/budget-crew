import { useState, type CSSProperties } from "react";
import { members } from "./crew-members.js";
import "./landing.css";

const advisers = ["Impact", "Obligations", "Deal Check", "Alternatives"];
const checks = ["Tests your daily budget", "Protects upcoming bills", "Checks the real discount", "Looks for a better option"];

export function LandingPage() {
  const [paused, setPaused] = useState(false);
  return <div className="landing">
    <a className="landing-skip" href="#landing-main">Skip to content</a>
    <header className="landing-header landing-width">
      <a className="brand" href="/" aria-label="Budget Crew home"><span className="brand-mark" aria-hidden="true">bc</span><span>budget<span className="brand-light">crew</span></span></a>
      <nav aria-label="Main navigation"><a href="#how-it-works">The idea</a><a href="#crew">Meet the crew</a><a href="#product">The product</a></nav>
      <a className="landing-header-cta" href="/app">Try the demo <span aria-hidden="true">↗</span></a>
    </header>
    <main id="landing-main">
      <section className="landing-hero landing-width" aria-labelledby="landing-title">
        <div className="landing-hero-copy">
          <p className="landing-kicker"><span className="landing-dot" /> A little clarity. Every day.</p>
          <h1 id="landing-title">Your daily budget,<br />run by a crew<br />of <em>AI agents.</em></h1>
          <p className="landing-intro">Bills set aside. A clear allowance for today.<br className="landing-desktop-break" /> And a team that thinks before you spend.</p>
          <div className="landing-actions"><a className="landing-button" href="/app">Open the live demo <span aria-hidden="true">↗</span></a><a className="landing-text-link" href="#how-it-works">How the crew works <span aria-hidden="true">↓</span></a></div>
          <p className="landing-fine">No sign-up. Synthetic money. Real teamwork.</p>
        </div>
        <div className="landing-hero-art" aria-label="Illustrative daily budget with a parallel crew purchase check">
          <div className="landing-art-orbit" aria-hidden="true" />
          <div className="landing-daily-card">
            <div className="landing-card-label"><span>YOUR EVERYDAY SPENDING</span><span aria-hidden="true">↗</span></div>
            <p>Today is looking clear.</p><strong className="landing-daily-amount">€50.20</strong>
            <div className="landing-daily-detail"><span>Today's allowance</span><span>26 NOV</span></div>
            <div className="landing-daily-bottom"><span><b>€251.02</b> left in this period</span><span>5 days to go</span></div>
          </div>
          <div className="landing-mini-check"><span className="landing-mini-icon" aria-hidden="true">%</span><div><small>BEFORE YOU BUY</small><p>“Is this actually a good deal?”</p></div><span className="landing-mini-arrow" aria-hidden="true">↗</span></div>
          <div className="landing-hero-crew"><div className="landing-hero-avatars" aria-hidden="true">{advisers.map((name) => <span key={name} style={{ background: members[name]!.color }}>{members[name]!.mark}</span>)}</div><p><b>Four perspectives. At the same time.</b><span>One considered answer from Judge.</span></p></div>
          <span className="landing-art-caption">An illustrative preview · not live account data</span>
        </div>
      </section>
      <div className="landing-proof-strip landing-width"><p><b>10</b> specialist agents</p><p><b>4</b> purchase advisers in parallel</p><p><b>1</b> clear answer for you</p><span>Independent minds.<br />One shared budget.</span></div>

      <section id="how-it-works" className="landing-section landing-width">
        <div className="landing-section-head"><div><p className="landing-kicker">01 / The idea</p><h2>A monthly budget.<br />A daily sense of calm.</h2></div><p>Not another spreadsheet to maintain.<br />Just a plan that moves with your day.</p></div>
        <div className="landing-steps">
          <article><span className="landing-step-number">01 <span aria-hidden="true">↗</span></span><h3>Start with your income.</h3><p>Your salary opens a new budget period. Rent, bills and planned essentials get their share first.</p></article>
          <article><span className="landing-step-number">02 <span aria-hidden="true">÷</span></span><h3>Find your number for today.</h3><p>What's left is spread over the days until payday. That's your daily allowance, not a spending target.</p></article>
          <article><span className="landing-step-number">03 <span aria-hidden="true">⇄</span></span><h3>Live a little. Re-plan a little.</h3><p>Log an expense or ask “can I buy?” The crew checks the impact; each recorded expense re-plans the remaining days.</p></article>
        </div>
      </section>

      <section id="crew" className="landing-section landing-width">
        <div className="landing-section-head"><div><p className="landing-kicker">02 / Ten minds, one team</p><h2>The crew works<br />at the same time.</h2></div><p>Different jobs. Independent agent loops.<br />No single chatbot pretending to be a team.</p></div>
        <div className="landing-members">{Object.entries(members).map(([name, member]) => <article key={name} style={{ "--character": member.color } as CSSProperties}><span className="landing-character" aria-hidden="true">{member.mark}</span><h3>{name}</h3><p>{member.role}</p></article>)}</div>
        <div className={`landing-parallel ${paused ? "is-paused" : ""}`}>
          <div className="landing-parallel-top"><div><p className="landing-kicker">A purchase check, explained</p><h3>“Can I buy these headphones for €179?”</h3></div><button type="button" onClick={() => setPaused(!paused)} aria-pressed={paused}>{paused ? "Play illustration" : "Pause illustration"}</button></div>
          <p className="landing-parallel-description">After Parser reads the request, four advisers work independently on the same purchase. Judge brings their answers together.</p>
          <div className="landing-loop-status" aria-hidden="true"><span className="landing-adviser-status"><i /> 4 advisers working in parallel</span><span className="landing-judge-status"><i /> Judge brings the answers together</span></div>
          <div className="landing-advisers">{advisers.map((name, index) => <div className="landing-adviser" key={name} style={{ "--character": members[name]!.color } as CSSProperties}><div><span aria-hidden="true">{members[name]!.mark}</span><b>{name}</b><i aria-hidden="true" /></div><p>{checks[index]}</p><div className="landing-progress" aria-hidden="true"><span /></div></div>)}</div>
          <div className="landing-connections" aria-hidden="true"><span /><span /><span /><span /></div>
          <div className="landing-judge"><span className="landing-judge-glyph" aria-hidden="true">⊥</span><div><span className="landing-kicker">Judge / One considered answer</span><div className="landing-judge-message" aria-hidden="true"><div className="landing-judge-waiting"><h4>Four perspectives come first.</h4><p>Waiting for the independent advisers.</p></div><div className="landing-judge-result"><h4>Wait. A discount isn't the whole story.</h4><p>Protect your daily allowance, then look for a better price.</p></div></div></div><span className="landing-judge-check" aria-hidden="true">✓</span></div>
          <p className="landing-illustration-note">Looping illustration · scripted example, not a live request</p>
        </div>
      </section>

      <section id="product" className="landing-section landing-width">
        <div className="landing-section-head"><div><p className="landing-kicker">03 / Inside the product</p><h2>Simple on the surface.<br />A whole crew underneath.</h2></div><a className="landing-text-link" href="/app">Explore the app <span aria-hidden="true">↗</span></a></div>
        <div className="landing-product-grid">
          <figure className="landing-product-main"><a href="/app" aria-label="Open Basic mode"><img src="/landing/basic.webp" width="1280" height="720" loading="lazy" alt="Basic mode showing a €50.20 daily allowance and a crew answer about a purchase" /></a><figcaption><span>01 / Basic</span><h3>Your day, in one clear answer.</h3><p>Log a coffee, add income, or ask before you buy.</p></figcaption></figure>
          <figure><a href="/app" aria-label="Explore budget history in Basic"><img src="/landing/history.webp" width="1280" height="720" loading="lazy" alt="Basic mode's synthetic June to November history with monthly spending, savings and past crew advice" /></a><figcaption><span>02 / The bigger picture</span><h3>Small decisions. A longer story.</h3><p>Six months of synthetic history to explore.</p></figcaption></figure>
          <figure><a href="/app?mode=pro" aria-label="Open Pro mode"><img src="/landing/pro.webp" width="1280" height="720" loading="lazy" alt="Pro mission control showing ten agent cards, a daily budget and a parallel activity timeline" /></a><figcaption><span>03 / Pro</span><h3>See the teamwork behind the answer.</h3><p>Switch to Pro for agents, tools and parallel timelines.</p></figcaption></figure>
        </div>
        <p className="landing-shot-note">Actual app captures · synthetic demo data · Basic opens by default</p>
      </section>

      <section className="landing-friday-wrap">
        <div className="landing-friday landing-width"><div><p className="landing-kicker">Made for the Black Friday question</p><h2>“Is this deal real,<br />and can I afford it?”</h2><p>A sale price is only half the decision. Your crew considers your budget, upcoming bills, price history and alternatives — together.</p><a className="landing-button" href="/app">Ask your crew <span aria-hidden="true">↗</span></a></div><blockquote><div><span className="landing-example-label">ILLUSTRATIVE JUDGE ANSWER</span><span aria-hidden="true">⊥</span></div><strong>Wait.</strong><p>“The discount may be tempting, but it leaves too little room for the days ahead. Keep your bills protected and check a cheaper alternative first.”</p><footer>Not just “is it cheaper?”<br /><b>“Is it right for your budget?”</b></footer></blockquote></div>
      </section>
      <section className="landing-built landing-width"><div><p className="landing-kicker">Built to work together</p><h2>Real agents. Deterministic money math.</h2><p><code>@mozaik-ai/core</code> runs independent agents concurrently. NestJS hosts the runtime, Centrifugo carries live activity, and React makes it clear. Budget calculations stay in code; agents interpret, not invent, the numbers.</p><p>All demo finances are synthetic. Screenshots use offline stub answers; live deal advisers can search the web.</p></div><a className="landing-text-link" href="https://github.com/yozzh/budget-crew">Explore the source <span aria-hidden="true">↗</span></a></section>
    </main>
    <footer className="landing-footer landing-width"><a className="brand" href="/">budget<span className="brand-light">crew</span></a><p>JigJoy Black Friday AI Hackathon 2026</p><span>Synthetic data, not financial advice.</span></footer>
  </div>;
}
