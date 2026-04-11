# Evaluation Foundation

This directory contains the foundation for **offline and online quality evaluation** of AI responses.

## Structure

```
eval/
├── datasets/         # Reference datasets (eval cases)
│   ├── suggestions-ref.json   # Reference cases for suggestion generation
│   └── chat-ref.json          # Reference cases for chat replies
├── scripts/          # Evaluation runner scripts
│   └── run-eval.ts   # Run offline evaluation against the live service
└── README.md         # This file
```

## Concepts

### Online Signals
Collected automatically during production use via `src/services/evaluation.ts → recordSignal()`:
- `suggestion.accepted` / `suggestion.rejected` — user feedback
- `chat.thumbs_up` / `chat.thumbs_down` — chat quality signals
- `ai.fallback_used` — how often the fallback model is triggered
- `ai.timeout` / `ai.rate_limit` — reliability signals

Signals are stored in the `usage_events` table with `eventType = 'eval.*'`.

### Offline Evaluation
Reference datasets in `eval/datasets/*.json` define input/expected output pairs.
The `scoreResponse()` function in `src/services/evaluation.ts` evaluates AI responses
against criteria (mustContain, mustNotContain, minLength) without requiring another LLM.

### Dataset Format

```jsonc
[
  {
    "id": "neg-001",
    "input": {
      "context": "Profissional ligou para regularizar débito",
      "question": "Como regularizar débito?",
      "category": "NEGOCIACAO"
    },
    "expected": {
      "mustContain": ["regulariza", "débito"],
      "mustNotContain": ["cliente"],
      "minLength": 50
    },
    "tags": ["negociacao", "debito"]
  }
]
```

## Running Offline Evaluation

```bash
# (future — Phase 3)
npx ts-node eval/scripts/run-eval.ts --dataset datasets/suggestions-ref.json
```

## Next Steps (Phase 3)
- [ ] Add `eval_runs` table for persisting run history
- [ ] Build admin dashboard for eval results
- [ ] Add LLM-based scoring (GPT-4o as judge) for semantic quality
- [ ] Implement A/B testing framework using `promptRegistry` and eval signals
