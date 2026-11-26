# Concept deck skeleton

Deck: `slides/concept/` (slide-maker React deck, 1280×720). Audience: hackathon judges, about 3 minutes before the live demo. Arc: problem → idea → crew → concurrency → Black Friday → architecture → close.

| # | Slide | Takeaway | Focal element |
|---|---|---|---|
| 1 | Cover | Your daily budget, run by a crew of AI agents | title |
| 2 | Problem | A monthly budget does not answer "can I spend this today?" | problem / answer split |
| 3 | Idea | One number you can act on | €75 for today (Alex, 27 Nov) |
| 4 | Crew | Ten specialists, one shared budget | 10 agent cards, Judge highlighted |
| 5 | Concurrency | One question, four advisers at once | swimlanes of a purchase check |
| 6 | Black Friday | Is it a real deal, and can I afford it? | Buy / Wait / Skip |
| 7 | How it works | Code counts the money, agents explain it | architecture diagram |
| 8 | Six months with Alex | not built yet: needs the June–October history (PXLT-535) | monthly saved / overspent |
| 9 | Close | Know your number, ask your crew before you buy | repository link |

Figures on slides 3 and 6 come from `simulateBudget` over `seed/month.json` on 27 November: €300 left, €75 today, 4 days; Instant Pot €49 → €251 left, tomorrow €83.67; Nintendo Switch €279 → €21 left, tomorrow €7.00; PlayStation 5 €399 → period ends at −€99.

Pending once Basic mode (PXLT-537) and the history (PXLT-535) are on `develop`: slide 8, and product screenshots of Basic (answer card, Judge decision) and Pro (timeline) on slides 5 and 6.

## Run

```sh
cd slides/concept
npm install
npm run dev                                   # http://localhost:5173, F5 to present
node scripts/check-slop.mjs src/slides/*.jsx  # source check
node scripts/shoot-slides.mjs                 # review/slide-NN.png
```
