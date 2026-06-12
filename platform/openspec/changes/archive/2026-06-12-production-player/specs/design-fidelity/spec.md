# design-fidelity (delta)

## ADDED Requirements

### Requirement: Shipped pages are the designed product with no development chrome

The player page SHALL render the designed paper experience full-bleed (PlayerFrame, TopBar, StepView, designed overlays, StartGate) and nothing else: no debug banners, fixture-switch links, environment instructions, facts dumps, simulation toggles, or developer footers. Gift and bonus awards SHALL use the designed CoinToast with the design-prototype WebAudio coin chime, gated by the quest-menu sound toggle. The landing page SHALL NOT ship developer callouts or inline admin panels (admin visibility lives on its own route). Demo/showcase content SHALL be real published quest data flowing through the production path (snapshot → bundle → player), never hardcoded step arrays inside components.

#### Scenario: Player page contains only the designed experience
- **WHEN** a player opens `/quest/{id}` for an owned quest
- **THEN** the page shows the paper player frame centered on the paper background with the designed top bar, step body, sync banner states and overlays — and contains no debug text, no simulation controls, no JSON dumps, and no fixture links.

#### Scenario: The full 7-template showcase quest is real data
- **WHEN** the backend starts and a player buys and opens «Ирония судьбы»
- **THEN** the quest is served as a frozen published snapshot (golden-ironia-sudby-v1) through the same bundle/attempt/fact path as any other quest, rendering all 7 designed templates including inline video blocks with duration labels.
